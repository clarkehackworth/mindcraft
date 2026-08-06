# Code issues seen while tuning `stayin_alive` / `food_gathering` live

**Commit:** uncommitted · 2026-08-05

Running log kept while watching Andy on the Prominence 2 server. These are
**code** problems, not policy ones — the policy changes made the same session
went out separately (see the bottom of this file).

**Status:** most are fixed and deployed. 1 is the stubborn one and is now split
into three measured causes, two fixed. 2 is probably not a bug. 4, 5 and 7 are
unexamined. A companion log covers
[the test harness](2026-08-05-live-test-harness.md) built partway through, and
why passive observation alone kept producing wrong answers.

| # | Problem | Status |
|---|---------|--------|
| 1 | `collectBlocks` banks nothing on modded logs | **partly fixed** — sweep added, still fails sometimes |
| 1b | `!collectBlocks("log")` refused, suggestions vanilla-only | fixed |
| 2 | Craft failures on modded woods | probably a symptom of 1, unconfirmed |
| 3 | Compiler churn: mixed `and`/`or`, malformed leaves | fixed |
| 3b | `!policy` compiles blind to the `active` layer | fixed |
| 4 | `sleep_at_night` finds a bed `go_to_bed` cannot use | open, low priority |
| 5 | `!newAction` returning "agent would not write code" | open, uninvestigated |
| 5b | Sandbox: `log` shadowed, `pf` missing | fixed |
| 6 | `interrupts: all` cancels collects that were nearly done | see 6c |
| 6b | Interrupted collect logged one abort per remaining block | fixed |
| 6c | No "nearly finished" grace in the arbiter | fixed |
| 7 | `!stayUntil` accepts a condition no amount of waiting reaches | open |
| 8 | No `is_freezing` condition on a server where freezing kills | fixed, confirmed live |

## 1. `collectBlocks` on modded logs breaks the block and banks nothing

Seventeen occurrences in six hours:

```
Broke 1 pine_log but nothing entered your inventory -- the drops were lost or are out of reach.
Failed to collect pine_log: Error: Digging aborted.
Failed to collect pine_log: Timeout: Took to long to decide path to goal!.
```

The warning at `src/agent/library/skills.js:747` is doing its job — it is
correctly refusing to claim wood the inventory can't back up. The bug is
upstream of it: `bot.collectBlock.collect()` breaks the block and then does not
end up with the drop for modded log types.

**Why this matters more than it looks.** This is the single root cause of
almost everything else the agent did wrong. No wood → no planks → no sticks →
no sword, no crafting table, no bed. Twenty deaths in six hours, all Zombie or
Stray, all while `holding nothing`. Every downstream symptom in this file and
most of the policy churn traces back here.

**Partly fixed 2026-08-05.** The cause is the first candidate: mineflayer's
`collectBlock` decides what drop to walk to from `minecraft-data`'s drop table,
which has no entry for a modded block, so it breaks the block and never goes to
pick the item up. The manual-collect branch of `collectBlocks` (used for crops
and torches) already sweeps with `pickupNearbyItems` afterwards; the
`collectBlock.collect` branch did not.

New exported `bankedAnything(bot, items_before, collected)` in `skills.js`: if
blocks broke and nothing was banked, sweep once, then re-check, and only then
report the drops lost. It skips the sweep when interrupted — the sweep
pathfinds once per item, and doing that after an interrupt holds the action open
past its grace period.

Extracted rather than left inline so the "swept, then re-checked" order is
testable without standing up a chunk to break blocks in
(`collect_pickup.test.js`).

Live after deploying, the agent produced its first ever `Collected 3 pine_log`
— and then a run of `Broke 15 pine_log but nothing entered your inventory`,
`Broke 20 pine_log ...`. The pattern was the tell: small collects worked, big
ones did not. `pickupNearbyItems` looks 8 blocks out, and a 20-log run walks the
bot right across the grove, so by the time the single end-of-run sweep fired the
first fifteen drops were far out of range.

Three further fixes, same session:

- **Sweep as we go, not once at the end.** `collectBlocks` now sweeps every
  `SWEEP_STRIDE` (4) blocks when nothing has been banked since the last look,
  tracked against a watermark that only moves forward. On a vanilla server
  `collectBlock` banks the item itself, the watermark advances, and the sweep
  never fires — so this costs nothing where it is not needed.

  The stride is not decoration. Sweeping after *every* block was tried first and
  made `Failed to collect log: Error: Digging aborted` much more frequent: the
  sweep walks the bot to each drop, and walking between digs is how a dig gets
  aborted. Four keeps the drops inside `pickupNearbyItems`' 8-block reach on a
  normal tree at a quarter of the movement. If that trade goes differently on
  another server, `SWEEP_STRIDE` is the knob.
- **An unreachable drop no longer kills the collect.** `goToGoal` throws on an
  unreachable goal by design, `pickupNearbyItems` did not catch it, and nothing
  at the new call site wrapped it — so one log that rolled somewhere unwalkable
  would have thrown straight out of `collectBlocks`. A drop the bot cannot reach
  is an ordinary outcome; it now gives up on that item and stops sweeping.
- **Drop entities under a modded name are seen.** The sweep matched only
  `entity.name === 'item'`. It now also accepts `objectType`/`displayName`/
  `entityType` spellings, so a server that registers its drop entity differently
  does not make the sweep silently walk nowhere.
- **The drop is given a moment to exist.** After those went in, the remaining
  losses clustered on *small* collects — `Broke 1 pine_log`, `Broke 2 log` —
  while `Collected 5 pine_log` worked. That pattern points at a race, not at
  distance: a long collect gets its later blocks swept anyway. The item entity
  arrives a tick or two after the block breaks, and the check ran immediately, so
  a one-block collect swept an empty world and declared the log lost while it was
  still spawning. There is now a 400ms settle before the recovery sweep, and a
  re-check first — if the drop simply arrived late, no pathfinding is spent.

**Measured, and not closed.** Five-minute windows on the live agent, same biome:

| | before any fix | after all of them |
|---|---|---|
| `Digging aborted` | 30 | **0** |
| `nothing entered your inventory` | 4 | 2 |
| largest successful collect | `Collected 0` | `Collected 14 log` |
| deaths | 10 in 6h, all unarmed | 0 in the window |

The agent now gets wood, crafts, and stops dying of not having a sword. What
still fails is the **large** collect: `Broke 15 log` and `Broke 16 log` both
banked nothing, despite the stride sweeping four times during each run. Small
collects are fine now, so this is not the spawn race.

Two explanations remained and they want opposite fixes, so rather than guess,
`describeLostDrops` now logs one line per surviving loss (to `console`, so it
stays out of the action output the model reads):

- `nearest item is N away (dy -M)` — the drops exist but fell outside
  `pickupNearbyItems`' 8-block reach. Felling a tall pine from the base leaves
  the bot pillared in the canopy while the logs land on the forest floor.
  Measured repeatedly once the diagnostic was in: 8.4 away (dy -7), 14.1
  (dy -10.6), 13.9 (dy -8.4), all with the bot up at y=71-73 and the drops at
  y=62-64. The recovery sweep now reaches `RECOVERY_PICKUP_RADIUS` (24) while the
  in-loop sweep stays at 8 — widening the in-loop one would mean walking that far
  between digs, which is how a dig gets aborted, but the recovery sweep runs once
  with nothing left to interrupt. One sample since measured 46 away, so this is
  reduced rather than eliminated.
- `no item entity within 64 blocks` — the block broke and dropped nothing at
  all. A server/mod behaviour, and no amount of sweeping will ever help.

**What the diagnostic found first was not either of those.** In the window after
deploying it: one `nothing entered your inventory`, and *zero* diagnostic lines.
That combination is only possible via `bankedAnything`'s early
`if (bot.interrupt_code) return false` — so the "loss" was an **interrupted**
collect, which had never looked for the drops at all.

That mattered more than the radius question. The agent was being told
"the drops were lost or are out of reach" every time a collect got interrupted,
which is how it learned that the trees here are unobtainable — a conclusion it
then acted on for hours. An interrupted collect is not evidence about the drops
in either direction, and now says so:

> Broke 3 pine_log, but was interrupted before the drops could be picked up.
> They are probably still on the ground where you were. This says nothing about
> whether pine_log is collectable here.

**Then both diagnostics landed, and the radius hypothesis was wrong.**

```
[lost drops] no item entity within 64 blocks -- the block broke and dropped nothing at all.
[lost drops] nearest item is 5.6 away (dy 5.0) ... bot y=73.0, drop y=78.0
```

The second one is the interesting one, and it is not a radius problem: 5.6 is
comfortably **inside** the 8-block reach, and the drop is 5 blocks **above** the
bot, not below it. Logs do not always fall to the ground — a felled log can come
to rest on the leaves of the tree it came from. The sweep saw it, pathfound to
it, and could not get there, because `pickupNearbyItems` set `canDig = false` and
there is no way up through a canopy without breaking something.

So the fix is not a wider radius, which would have been the wrong change and is
what guessing would have shipped. `pickupNearbyItems` now allows digging, with
`allow1by1towers` off. It cannot wander: the goal is one specific item already
within `PICKUP_RADIUS`, so the worst case is a few leaf blocks broken in a tree
that is already half gone.

(The 8 is now a named `PICKUP_RADIUS`. It was about to exist in two places that
had to agree — the sweep and the diagnostic that reports against it.)

**A note on the diagnostic itself, since it is the point.** Its first version
ended every line with "but the sweep only reaches 8" — and then printed 5.6. It
asserted a cause the number it had just measured contradicted. A diagnostic that
editorialises is worse than one that only reports, because it launders a
hypothesis into something that reads like a finding. It now states the distance
and says which side of the reach it falls on, nothing more.

### The other message: `no item entity within 64 blocks`

A genuine "broke it, got nothing" — no sweep can ever help that. It recurred,
including on a `Broke 16 log`, so it is the dominant remaining failure rather
than a one-off. Extending the diagnostic to record what was in hand gave:

```
[lost drops] broke log holding snowball and no item entity appeared within 64 blocks.
```

**The tool check that should have caught this cannot.** `collectBlock` guards
each dig with `block.canHarvest(itemId)`, and in `prismarine-block`:

```js
canHarvest (heldItemType) {
  if (!this.harvestTools) { return true }   // for blocks harvestable by hand
  ...
}
```

`harvestTools` comes from `minecraft-data`, which has no entry for any modded
block — so `canHarvest` returns `true` unconditionally for every block on this
server. The guard is not merely unreliable here, it is a **guaranteed no-op**.
That is one more instance of the theme already in this log's Recurring Themes:
the vanilla registry is a lie on a modded server.

**What is fixed:** the report. All three failures used to say *"the drops were
lost or are out of reach"*, and two of the three are not about the drops at all.
`bankedAnything` now returns `'interrupted'` / `'no_drop'` / `'unreachable'`
instead of a bare `false`, and each gets an accurate message. The `no_drop` one
is the load-bearing change, because it is the one the agent was misreading:

> Broke 16 log and it yielded nothing at all — no dropped item ever appeared.
> This is not bad luck and retrying the same way will not help: on this server a
> block can need a tool the client does not know about. Equip or craft the right
> tool (axe for wood, pickaxe for stone) and try once more, or go collect
> something else.

**The tool theory is dead, and the data that killed it was already in hand.**
Grepping the logs for what the agent has ever collected:

```
Collected 16 log
Collected 15 log
Collected  4 log
```

…against every mention of an axe, all three of which turn out to be entries in a
suggestion/recipe list rather than anything held. This agent has never owned an
axe and has still banked sixteen logs in one run. **Logs drop bare-handed on this
server**, and the failures are intermittent rather than categorical.

That matters twice over, because the first version of the new `no_drop` message
told the agent *"Equip or craft the right tool (axe for wood, pickaxe for stone)
and try once more"* — advice built on the hypothesis, shipped before the
hypothesis was checked against data that was sitting in the same log file. It now
says what is actually known:

> Broke 16 log but no dropped item ever appeared, so nothing was banked. This
> happens intermittently here and the same block type does work other times, so
> it is not proof that log is uncollectable — check !inventory, and if you need
> more, try again from a different spot.

The `canHarvest` finding above still stands on its own: the guard genuinely is a
no-op on modded blocks. It just is not the explanation for this.

**What is left to test.** mineflayer only tracks entities it could parse, so a
modded item entity it choked on would be invisible to `getNearestDrop` while
being perfectly real on the server. That fits the intermittency exactly — the bot
banks those drops only when it happens to walk over one, which is also why long
collects succeed more often than short ones. The diagnostic now lists every
entity within 16 blocks when `no_drop` fires; unrecognised names there would
settle it.

**Two guesses avoided, one shipped.** The natural move after the first sample was
to make `collectBlock` equip an axe before breaking wood — a guess dressed as a
fix, and on a bot with no axe and no wood to make one it would have changed
nothing while looking like progress. The guess that *did* get shipped was the
message telling the agent to do the same thing by hand. Same error, one layer
out, and it took a deliberate look at old logs rather than new ones to catch it.

## 1b. `!collectBlocks("log", 8)` was refused, and the suggestion sent the agent after a tree that does not exist here

```
Agent executed: !collectBlocks and got: Invalid block type: log.
  Did you mean one of: acacia_log, birch_log, cherry_log, dark_oak_log, ...
```

Two mistakes stacked. `skills.collectBlocks` has understood family names all
along — the policy engine's `collect` action passes `"log"` and it works — but
the command-argument validator in `commands/index.js` only accepted literal
registry names, so the *command* form was rejected. Then the rejection listed
the vanilla logs. The wood on this server is pine. The agent was told to go and
get `oak_log`, and it went, repeatedly, and there are no oaks in that biome.

**Fixed 2026-08-05.** New `isKnownBlockName` in `mcdata.js`, used by the
`BlockName` and `BlockOrItemName` checks: a name passes if the registry has it,
*or* if it is a family name that expands to at least one block the registry has.
A name that is neither still fails loudly — `sword` is not a block family and
must keep failing, since it would otherwise silently match nothing at runtime.

The vanilla-first ranking in `suggestNames` is still wrong for a pine world, but
it is only reached now for genuinely unknown names, and its own comment already
flags the ranking as a known shortcut.

## 2. Craft failures on modded woods — probably downstream of 1, not its own bug

```
You do not have the resources to craft a wooden_sword. It requires: pine_planks: 2, stick: 1.
You do not have the resources to craft a pine_planks. It requires: pine_log: 1.
You do not have the resources to craft a crafting_table. It requires: pine_planks: 4.
```

First read of this was "`craftRecipe` does not walk `pine_log → pine_planks →
stick`". On a closer look that is probably wrong, and it is worth writing down
why so nobody re-derives it:

- `craftRecipe` already walks the chain in code, at `skills.js:230-243`, via
  `mc.getCraftingPlan`.
- `mcdata.js:15` derives `WOOD_TYPES` from the **live server registry**, not
  from `minecraft-data`, so pine is a known wood rather than a special case.
- The second line above is the tell: it is failing to craft `pine_planks`
  *itself* for want of `pine_log`. The agent had no logs at all. So this is
  problem 1 wearing a different message, not a broken recipe walk.

**Unconfirmed**, because it cannot be checked offline — `getCraftingPlan` needs
the registry the bot receives on connect, and `useRegistry` is only called once
a bot is live. To settle it: get one pine log into the agent's inventory by any
means and call `!craftRecipe wooden_sword`. If it produces planks and sticks,
this entry closes and only problem 1 is real.

## 3. Policy compiles keep failing on the same three mistakes

Live, in one session, from the agent's own `!policy` calls:

```
Rule "night_no_exposure" waits until no mob is nearby but never moves...
Rule "no_deep_water_night": unknown condition "undefined".
Rule "pillager_run": stay needs a valid "until" condition: mixing "and" with "or" is not supported.
Response was not valid JSON: Unexpected end of JSON input
Error: Context length exceeded
```

The validator messages are good — they explain the fix. The problem is that the
compiler is being asked to fix them by an LLM that keeps making the same three
errors, and each retry is a full LLM call. Two of these are cheaply repairable
in `repairPolicy` rather than by another round trip:

- **`unknown condition "undefined"`** — the model emits a condition object with
  no `cond` key, usually because it nested `{"not": {...}}` one level too deep.
- **mixing `and`/`or` in a `stay` `until`** — `parseConditionExpr` could accept
  the mixed form with explicit precedence instead of refusing it, which would
  delete an entire class of retry.

**Fixed 2026-08-05.** Both of the cheap ones, in `policy.js`:

- `parseConditionExpr` now accepts mixed `and`/`or`, with `and` binding tighter
  (`a and b or c` → `(a and b) or c`). It was refusing the form outright, and
  the model writes it unprompted — three retries in one session, one of which
  burned the whole `!policy` call after the model "simplified" to something
  worse.
- New `normalizeCondition`, called from `repairPolicy` before any other check
  reads the condition tree, rewrites the four leaf shapes the model actually
  emitted: `{"cond": {"cond": ...}}`, `{"condition": "..."}`,
  `{"is_night": {...}}`, and `{"all": <object>}`. It repairs only shapes whose
  reading is unambiguous — a leaf naming something that is not a condition is
  left broken so the validator still reports it.

Ordering matters and is why the normalize runs first: `triggersOnProximity` and
friends read `when`, so judging a rule before its leaf is readable would let a
duplicate-of-cowardice rule survive on a technicality. There is a test for that.

**Context length exceeded** is separate and worth its own look: the merge prompt
carries the base policy JSON *and* every attribute policy JSON in full
(`buildMergeInstructions`), and the base is now 19 rules with long descriptions.
The descriptions are load-bearing documentation for humans but the compiler
probably does not need them verbatim.

## 3b. `!policy` compiles blind to the `active` layer, so the agent re-derives rules it already has

This is the cheapest high-value fix in the file.

`compilePolicy(agent, source.join('. '), goal)` — called from the `!policy`
handler in `commands/actions.js` — builds its prompt from `COMPILE_PROMPT`, the
condition/action registry, the **self** layer's own source lines, and the active
goal. It never passes the `active` layer. The agent therefore has no way to know
what a person already put in place, and writes rules for it from scratch, every
restart.

Counted across one six-hour session, all in the self layer, all of them things
the `active` layer already did:

| Concept | Names the agent invented for it |
|---|---|
| flee illagers | `pillager_avoidance`, `pillager_flee_shelter`, `pillager_immediate_flee_shelter`, `pillager_run`, `flee_pillager_types`, `stray_avoidance`, `stray_pillager_death_response` |
| hold a weapon | `weapon_before_exploring`, `weapon_before_outside`, `equip_weapon_before_outside`, `require_weapon_outside`, `require_weapon_before_exploring`, `weapon_equipped_always` |
| shelter at night | `night_no_weapon_shelter`, `night_no_weapon_no_bed`, `night_no_weapon_stay_shelter`, `night_no_exposure`, `hostile_nearby_shelter` |
| surface when drowning | `drowning_emergency_surface`, `underwater_stuck_climb_out` (both exact duplicates of the pinned base rule) |

The self layer caps at 8 source lines, so each new one evicts an older one and
the cycle restarts. Every entry above is at least one LLM call, several are
three (the retry loop), and the ones that compile go on to *outrank* the base
rules they duplicate — `freeze_rain_shelter` was a pinned `{"act": "stay"}` on
"night OR hostile within 24", which held the bot motionless in the open all
night and is the most likely proximate cause of the ten zombie deaths.

**Fix:** include the composed `active` rules in the compile prompt — names and
one-line descriptions are enough, not the full JSON — with an instruction along
the lines of "these already run; do not restate them, only add what they miss."
`buildMergeInstructions` already does exactly this for the base/attribute merge,
so the pattern exists.

**Fixed 2026-08-05.** `compilePolicy` grew a fourth argument, `existing`, and
appends a one-line-per-rule summary of it (new `summarizeRules`) to the prompt,
with an instruction not to restate any of them and to return an empty `rules`
array if the instruction is already covered. The `!policy` handler passes the
*other* layer's rules — not the layer being written, since that call rewrites
its own layer wholesale from source and showing it its own rules would tell it
to stop writing them.

Names and actions only, not the full JSON: the descriptions in
`stayin_alive.json` are written for human readers and are most of its bulk, and
the compile prompt is already close enough to the limit to have thrown
"Context length exceeded" once.

**Interim mitigation also applied:** cleared the self layer and moved the raider
rule into the base (`flee_ranged_raiders`). Worth doing regardless — before the
fix, within ten minutes of regenerating, the agent had already written
`flee_pillager_types` and `pin_cold_weather_stay_near_torches_or_shelter` into a
fresh self layer.

One of those deserves a note on its own: **cold weather has no condition to
compile to.** The Frostiful mod does freezing damage, the agent has noticed it
dying to that, and there is no `temperature`/`is_freezing` leaf in `CONDITIONS`.
So the model fakes it with `is_night` or `hostile_nearby` and lands on a `stay`,
which is the exact failure above. Either add the condition or the agent will
keep producing that rule and it will keep being wrong.

## 4. `sleep_at_night` finds a bed that `go_to_bed` then cannot use

Nineteen `Could not find a bed to sleep in.` while the rule's own trigger
(`block_nearby bed 16`) said one was there. Either `block_nearby`'s "bed"
family matches something `goToBed` rejects, or the bed is out of pathing reach
and the failure message is misleading. Low priority next to 1 and 2 — the agent
has never actually owned a bed — but the condition and the action disagreeing is
the same class of bug as the old `hold_weapon_when_threatened` one.

## 5. `!newAction` returning "agent would not write code"

Seventeen times. Distinct from a code error — the model produced no code block
at all. Probably a prompt/parse issue rather than a skill failure. Not
investigated.

## 5b. Two things the generated-code sandbox got wrong, both fixed

Seen live, repeatedly, in `Generated code threw error:`

```
TypeError: log is not a function
TypeError: Cannot read properties of undefined (reading 'GoalNear')
TypeError: goals.GoalPosition is not a constructor
```

**`log is not a function`** — the sandbox does expose `log`, so this was
shadowing. The generated code runs spliced directly into the template's function
body, and in a forest the model writes `const log = bot.findBlock(...)` about as
often as not. That binding shadowed the logger for the whole body, including the
template's own `log(bot, 'Code finished.')` epilogue — so a run that had already
done its work reported as a crash.

Fixed by binding the logger as a **default parameter** in both templates
(`async (bot, __log = log) => ...`). Default parameters resolve in the parameter
scope, which is outside the body block the code is spliced into, so a body-level
`const log` can no longer reach it.

The template alone was not enough, and the first deploy did not fix it. The
calls that were actually failing are the ones `_stageCode` splices into the
body: the `console.log` rewrite, the `log("` rewrite, and — the frequent one —
the interrupt check appended after *every* statement:

```js
code = code.replaceAll(';\n', '; if(bot.interrupt_code) {log(bot, "...");return;}\n');
```

That put a `log(...)` call on the same line as `let log = ...`, so the shadow
broke the check before the code had done anything at all. All three rewrites now
emit `__log`. Verified against the exact generated body from the live failure
(`let log = world.getNearestBlock(bot, 'pine_log', 16)`), which now runs.

Code that shadows `log` and then calls `log` *itself* still fails, but that is
the model's own error and the message says so.

**`pf` was missing from the compartment.** The lint template imports `pf`, the
sandbox exposed only `pf.goals` as `goals`. So `new pf.goals.GoalNear(...)` —
the form the pathfinder docs use — passed lint and then died at runtime. The
lint template already carried a comment asking for the two to be kept in step;
`pf` is now exposed too.

`goals.GoalPosition` is a third thing: that class does not exist in
mineflayer-pathfinder at all (it is `GoalBlock`/`GoalNear`/`GoalXZ`). Nothing to
fix in the sandbox — but if it keeps recurring, the codegen prompt should name
the goal classes that exist.

## 6b. An interrupted collect logged one abort per remaining block, and ignored the interrupt

This is the visible half of 6, and it was a plain bug:

```js
catch (err) {
    if (err.name === 'NoChests') { ...; break; }
    else { log(bot, `Failed to collect ...`); continue; }   // <-- skips the check below
}
if (bot.interrupt_code) break;
```

An interrupt aborts the dig in progress **and every dig after it**. Because the
catch's `continue` jumps past the interrupt check at the bottom of the loop, an
interrupted collect walked the entire remaining block list, failing each one:

```
Failed to collect log: Error: Digging aborted.       (x20, identical)
Collected 0 log.
action "action:collectBlocks" ignored the interrupt for 10s, abandoning it
```

Three costs. The action output filled with twenty identical lines and got
truncated, so whatever else it had to say was lost. The agent read "Collected 0"
and concluded the trees were unreachable. And the loop took long enough to be
killed by the abandon-timeout rather than stopping on its own.

**Fixed 2026-08-05:** check `bot.interrupt_code` in the catch, before logging
and continuing. This does not make the collect finish — that is 6 below — but an
interrupted collect now stops immediately and reports what it actually managed.

## 6c. Nothing let a nearly-finished action finish — **fixed**

`interrupts: all` meant *right now*, with no notion of "this was one block from
done". A 16-log collect cancelled at block 14 threw away the whole trip: drops
are only banked as they are picked up, so the agent read `Collected 0` and
concluded the trees were unreachable. What usually cancelled it was not danger —
it was `action:newAction`, the model starting a new idea.

The fix has three parts, and the design constraint is that it must never delay a
reflex.

**Urgency is declared by the interrupter, not inferred.** `runAction` takes
`urgent`, defaulting to **true** — so any caller that has not been updated
behaves exactly as before, and nothing that keeps the agent alive has to remember
to opt out. Only two places opt in to waiting:

| Interrupter | urgent | why |
|---|---|---|
| pinned policy rules (`flee_ranged_raiders`, `eat_when_starving`, …) | yes | `pinned` already means "this keeps me alive"; reused verbatim |
| `self_preservation`, `unstuck`, `cowardice`, `self_defense` | yes | the reflex modes |
| `hunting`, `item_collecting`, `torch_placing`, `elbow_room`, `idle_staring` | no | can wait a moment |
| every `action:*` the model issues, including `newAction` | no | a new idea is never an emergency |

**Progress is reported, not guessed.** `reportProgress(bot, done, total)` in
`skills.js`, called by `collectBlock` as it goes. It lives on the bot because
that is the only object a skill is handed. An action that reports nothing is
never nearly-finished — the safe default, and what every action does today
except this one.

**The window is small and bounded.** Past 75% done, a non-urgent interrupter
waits up to 3 seconds; `requestInterrupt` is not called during that window, so
the action either lands or the normal cooperative stop proceeds. Stale progress
is cleared when a new action takes the slot, so the next action cannot inherit a
grace it never earned.

`finish_grace.test.js` covers all of it, including the two that matter most: an
urgent interrupter does not wait, and a nearly-done action that never ends is
still stopped.

Confirmed live within minutes of deploying, on exactly the case it was built for:

```
action "action:craftRecipe" trying to interrupt current action
  "mode:policy:active:gather_wood_for_base" (letting it finish first)
...
Collected 14 log.
```

Before, that `craftRecipe` would have cancelled the trip at block 14 and the
agent would have been told it collected nothing.

## 8. `is_freezing` — **fixed on the second attempt**

Freezing kills here, the agent knows it, and it kept writing itself cold-weather
rules that the compiler had no vocabulary for — so the model substituted
`is_night` or `hostile_nearby` and landed on `{"act": "stay"}`, the worst shape
available. It arrived there because nothing could express what it meant.

**The first attempt read entity metadata key 7 (`ticks_frozen`) and did not
work.** Penned in powder snow by `tools/live_test.sh freeze`, the bot froze to
death three times in a row and the condition never fired once. A bounded metadata
probe then showed why, including a sample taken as the bot died:

```
[freeze probe 1/40] health=52 non-zero numeric metadata: 9=52 10=4802351 20=915 21=127
[freeze probe 6/40] health=0  non-zero numeric metadata: 9=2  10=4802351 20=915 21=127
```

Key 7 never appears, not even mid-death. This server does not send it. Key 7 is
correct for the vanilla 1.17+ layout; that is a specification, and the
specification is not what is on the wire.

(Key 9 is health and reads **52**. The modded maximum is not 20, so anything
assuming vanilla health ranges — including any policy rule using `health_below`
with vanilla numbers in mind — is wrong here. Worth its own look.)

**The second attempt reads the cause, and is confirmed.** `is_freezing` is now
true when the bot stands in powder snow (certain), or when it is snowing in a
cold biome — via `world.getBiomeName`, which reads the server registry and so
knows modded biome names. The biome half deliberately requires weather as well:
this agent lives in a snowy forest permanently, and firing on biome alone would
mean a pinned `interrupts: all` rule that never stops firing.

Re-run against the pen:

```
FOUND: (POLICY RULE 'active:get_out_of_the_cold') YOU ARE FREEZING...
-- agent side: mineflayer sees it, is_freezing is live
```

`move_away` declares that it clears `is_freezing`, which is what lets the base
rule `get_out_of_the_cold` pass the livelock check honestly rather than by
exemption: walking out of the powder snow is what actually stops it. Partial,
exactly as `flee` clearing `hostile_nearby` is partial, but progress rather than
waiting.

**The general lesson, which is why the harness exists.** No amount of watching
would have caught the first version. A condition that never fires looks exactly
like a condition whose situation never arose, and I had already written it up as
"correct by the spec, unconfirmed" and moved on. It took deliberately causing the
situation to find out it was simply broken. See
[the harness log](2026-08-05-live-test-harness.md).

## 6. Long-running collects are cancelled faster than they can finish

```
Failed to collect pine_log: GoalChanged: The goal was changed before it could be completed!
```

Repeatedly, in bursts. The agent's own self-layer rules (`interrupts: all`,
short cooldowns) were pre-empting wood gathering every few seconds, so even when
wood *was* reachable the collect never ran to completion. Clearing the self layer
relieved the immediate symptom, but the arbiter has no notion of "this action was
nearly done, let it finish" — a rule with a satisfied trigger always wins. Worth
considering a small grace window before an `interrupts: all` rule cancels an
action that is already in progress.

## 7. `!stayUntil` accepts a condition no amount of waiting can reach

The policy validator refuses a rule whose `stay` waits on `not hostile_nearby`,
because standing still does not make a mob leave — it says so in as many words,
and it has caught the agent writing that rule at least five times. The
`!stayUntil` *command* has no such check:

```
!stayUntil("not is_night and not hostile_nearby 12", -1)
```

That was issued live, unarmed, at night, minutes before a zombie death. The
`not is_night` half is reachable, so it does eventually end — but the agent
believes it is now safe and stops doing anything about not being safe.

The check the validator already implements should apply here too. `!stayUntil`
and the policy `stay` action parse the same condition grammar through the same
`parseConditionExpr`, so the reachability rule could live next to it and be
applied by both.

## 8. There is no condition for freezing, on a server where freezing kills

```
Agent died:  clarkhackworth froze to death
```

Frostiful does cold damage and the agent has noticed it dying to it — it keeps
writing itself rules about staying near torches. There is no `temperature` or
`is_freezing` leaf in `CONDITIONS`, so the compiler has nothing to compile those
instructions into, and the model substitutes `is_night` or `hostile_nearby` and
lands on a `stay`. That is the single worst rule shape available, and the agent
arrives at it because the vocabulary has no word for what it is trying to say.

Either add the condition (mineflayer does not expose a freezing flag directly,
but `bot.entity.metadata` carries the frozen-ticks field, and the biome is
already available), or the instruction has nowhere sensible to go.

## Policy changes shipped alongside this (not code)

- `policies/stayin_alive.json`: `flee_chillager` → `flee_ranged_raiders`, now
  covering stray/pillager/vindicator/ravager as well; `craft_shovel_for_snow`
  gated on actually owning wood.
- `policies/food_gathering.json`: dropped the five-sword gate from
  `bake_bread`, `cook_raw_meat`, `build_a_furnace_for_cooking` and
  `go_find_food_when_none_in_reach` — combined with problem 1 it meant an agent
  that could not get wood could not eat either. `go_find_food_when_none_in_reach`
  needed a positive trigger put back afterwards (`hunger_below 18`), since the
  sword clause had been the only one it had.
- `policies/stayin_alive.json`: `get_a_bed`'s prompt no longer asserts the
  vanilla recipe. It told the agent a bed is 3 wool of one colour plus 3 planks
  and sent it after sheep, at length, every six minutes. On this server
  `!craftRecipe white_bed` answers **`feather_block: 3, pine_planks: 3`** — every
  sheep hunt it ever ran was for an ingredient the bed does not take. The prompt
  now opens with `!getCraftingPlan("white_bed", 1)` and works from the answer.

  This is worth generalising: any prompt that hardcodes a recipe is a prompt
  that is wrong on a modded server. `!getCraftingPlan` exists; the prompts
  should use it rather than assert.
