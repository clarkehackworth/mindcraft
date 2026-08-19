# Arm, mine, and actually recover the grave

**Commit:** `4917d30` · 2026-08-18 · shipped

The bot was configured to survive and gather food, and it did -- but it kept
dying in the frozen taiga at night **unarmed**. Of the 54 deaths logged over a
12-hour window, 37 were unarmed, and after each one it respawned with almost
nothing in its inventory. Two things compounded:

1. **The death spiral.** On death the bot drops its gear. The compiled
   `go_back_for_your_grave` rule is supposed to make it walk back and dig
   itself out, but the free-form rules the agent had written into the **self
   layer** -- "stay 32 blocks from your death spot until it is daytime and you
   are armed" and "stay away from any previous death location" -- outrank the
   active layer and directly contradict grave recovery. So the bot never went
   back, and every respawn restarted from zero items.
2. **No progression path.** The `leveling_up` (wood → stone → iron → diamond
   gear ladder) and `mining` (ore economy) attributes existed in `policies/`
   but were dormant. The active policy was `stayin_alive` + `food_gathering`
   (60 rules), so the best weapon the bot could ever make was a wooden sword.

## The change

- Cleared the self layer (`clearlayer self`). Every legitimate lesson it
  carried (flee when hurt, avoid water, eat before starving, dig in when
  chased) was already compiled into the active layer; what remained was
  duplication plus the two rules that broke grave recovery. Per the
  improvement-loop doc: fold, then clear.
- Added `policies/survive_upgrade.json`: the current validated 60-rule active
  policy plus the 18 rules from `leveling_up` + `mining` (zero name
  collisions), one combined goal covering survive/food/gear/ore, and the
  `elbow_room` mode the mining attribute declares. 78 rules total.
- Installed with `regen survive_upgrade` (no attributes), which takes
  `generatePolicy`'s no-LLM copy path: instant, deterministic, no merge.

## Rejected options

- **The 4-profile LLM merge** (`regen stayin_alive food_gathering
  leveling_up mining`). It ran for 18 minutes and died with `Context length
  exceeded`: the merge prompt is all four profiles' full rule JSON plus the
  registry docs, which is structurally larger than the model's context. A
  retry cannot fix a cap, and the failed attempt had already burned the
  agent's turn. This is now the standing workaround for adding more than one
  attribute at once: pre-compose the base, then regen with no attributes.
- **Editing the individual profile files** to pre-merge. The profiles are the
  library source of truth; baking one specific composition into them would
  change what every future regen can express, and any *other* composition
  would still need the (overflowing) merge.
- **Keeping the self layer and deleting only the two bad rules.** Self-layer
  rules outrank the active layer, so every one of them is a live override
  candidate, and the rest were duplicates of compiled rules anyway. Clearing
  is the smaller surface.

## Verification

- `validatePolicy` passes on the combined profile (78 rules, unique names);
  `src/utils/policies_valid.test.js` passes 6/6 with the new file present.
- Live policy after regen: base `survive_upgrade`, 78 rules, all 18 new
  gear/mining rules present, combined goal set, `elbow_room` on, self layer
  empty (0 rules).
- Logs in the following ten minutes: `mine_coal_ore` and `keep_stone_stocked`
  (the previously dormant mining attribute) and `arm_yourself_from_the_chest`
  firing alongside the existing `gather_wood_for_base`. The hundreds of
  `nearestEntity` stack frames in the same window are prismarine-entity
  `objectType` warnings against the 443-mod server -- caught and logged, not
  uncaught throws, so no tick-path change needed.

Note: the bot's free-text memory still says "stay 32b from deaths", but that
is now a soft hint, not a compiled override -- `go_back_for_your_grave` can
fire again, which is what breaks the death spiral.
