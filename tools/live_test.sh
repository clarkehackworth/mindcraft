#!/usr/bin/env bash
# Drive the live agent through a scenario instead of waiting to catch one.
#
# Passive observation found real bugs in this codebase but cost hours per
# sample, and two of the hypotheses it produced were wrong. This puts the bot in
# the state under test on purpose.
#
# Usage:
#   Setup primitives (compose these into scenarios):
#     tools/live_test.sh pos                     where is the bot
#     tools/live_test.sh rcon "<command>"        raw server command
#     tools/live_test.sh tp <x> <y> <z>          move the bot
#     tools/live_test.sh summon <mob> [dist]     spawn a mob near the bot (default 10)
#     tools/live_test.sh give <item> [n]         put items in its inventory
#     tools/live_test.sh effect <eff> [s] [amp]  apply a status effect
#     tools/live_test.sh damage [n]              hurt it (default 6 = 3 hearts)
#     tools/live_test.sh heal                    full health + saturation
#     tools/live_test.sh clearinv                empty its inventory
#     tools/live_test.sh time <day|night|...>    set time
#     tools/live_test.sh weather <clear|rain|thunder>
#   State:
#     tools/live_test.sh snapshot [name]         save pos + inventory
#     tools/live_test.sh restore [name]          tp back, heal, re-give items
#   Talk to the agent (mindserver socket, no log grepping):
#     tools/live_test.sh say "<msg>" [waitSecs]  chat/!command to the agent, stream output
#     tools/live_test.sh evt <pattern> [secs]    await an EVT line on the socket stream
#     tools/live_test.sh restart|stop|start      agent process control
#     tools/live_test.sh policy                  dump the composed policy state
#     tools/live_test.sh regen <base> [attrs...] regenerate active layer from profiles
#     tools/live_test.sh rules [since]           rule fire counts (default 30m)
#     tools/live_test.sh food [since]            food gains/losses/eats + tally
#     tools/live_test.sh path [since]            pathfinder verdicts + breadcrumbs
#   Iterate:
#     tools/live_test.sh deploy [files...]       push changed files to container, restart agent
#   Observe:
#     tools/live_test.sh watch <pattern> [since] tail the agent log for a pattern
#   Scenarios: freeze | wood | raider [mob] | hunger | night
#
# ponytail: bash + rcon-cli + one small socket client, no framework. Everything
# here is one server command and an assertion; a harness would be more code
# than the tests.
set -euo pipefail

HOST=${MC_HOST:-docker.lan}
MC=${MC_CONTAINER:-minecraft-prominence2}
BOT_CONTAINER=${BOT_CONTAINER:-mindcraft}
PLAYER=${MC_PLAYER:-clarkhackworth}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SNAPDIR=${SNAPDIR:-/tmp/live_test_snapshots}

rcon() { ssh "$HOST" "docker exec $MC rcon-cli \"$*\"" 2>&1; }
botlog() { ssh "$HOST" "docker logs --since ${2:-2m} $BOT_CONTAINER 2>&1" | grep -E "$1" || true; }

# Mindserver auth token: env wins, else pull it from the container (SETTINGS_JSON
# env overrides /app/settings.js, so check both, env first).
token() {
    if [ -n "${MINDSERVER_TOKEN:-}" ]; then echo "$MINDSERVER_TOKEN"; return; fi
    ssh "$HOST" "docker exec $BOT_CONTAINER sh -c 'printenv SETTINGS_JSON; cat /app/settings.js' 2>/dev/null" \
        | grep -o '"mindserver_auth_token"[: ]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/'
}

# Talk to the agent over the mindserver socket -- instant and structured, and
# !commands sent this way bypass the LLM entirely (no 30s wait, no API cost).
drive() {
    MINDSERVER_TOKEN="$(token)" MINDSERVER_URL="${MINDSERVER_URL:-http://$HOST:8080}" \
        node "$ROOT/tools/drive.js" "$@"
}

# Bot position as three integers, via the server rather than the agent, so it
# works even when the agent is wedged.
pos() {
    local raw out
    raw=$(rcon "data get entity $PLAYER Pos")
    out=$(echo "$raw" | grep -oE '\-?[0-9]+\.[0-9]+' | head -3 | awk '{printf "%d ", int($1)} END {print ""}')
    # An offline or mid-respawn bot answers "No entity was found", and the old
    # version happily returned an empty string -- so a scenario ran `setblock`
    # with no coordinates, changed nothing, and reported "the pen did not work"
    # as though that were a result about freezing. A test that cannot set up
    # must fail loudly, not quietly produce a negative.
    if [ "$(echo "$out" | wc -w)" -ne 3 ]; then
        echo "cannot locate $PLAYER (offline, or respawning): $raw" >&2
        return 1
    fi
    echo "$out"
}

# The bot dies and respawns often enough that any scenario can lose it mid-setup.
require_pos() {
    for _ in $(seq 1 12); do
        if out=$(pos 2>/dev/null); then echo "$out"; return 0; fi
        sleep 5
    done
    echo "gave up waiting for $PLAYER to be locatable" >&2
    return 1
}

# Watch for a pattern to appear in the docker log, up to a deadline. Returns 1
# if it never does, so a scenario that silently fails to reproduce is a
# failure, not a pass. Prefer `evt` (socket, instant) where an EVT line exists.
await() {
    local pattern=$1 secs=${2:-90} start
    start=$(date +%s)
    while [ $(( $(date +%s) - start )) -lt "$secs" ]; do
        if botlog "$pattern" "3m" | grep -q .; then
            echo "FOUND: $(botlog "$pattern" "3m" | tail -2)"
            return 0
        fi
        sleep 5
    done
    echo "NOT SEEN in ${secs}s: $pattern"
    return 1
}

case "${1:-}" in
pos)  pos ;;
rcon) shift; rcon "$@" ;;

# --- setup primitives ---------------------------------------------------------
tp)       rcon "tp $PLAYER ${2:?x} ${3:?y} ${4:?z}" ;;
summon)   read -r X Y Z <<<"$(require_pos)" || exit 1
          rcon "summon ${2:?mob} $((X+${3:-10})) $Y $Z" ;;
give)     rcon "give $PLAYER ${2:?item} ${3:-1}" ;;
effect)   rcon "effect give $PLAYER ${2:?effect} ${3:-30} ${4:-0} true" ;;
damage)   rcon "damage $PLAYER ${2:-6}" ;;
heal)     rcon "effect give $PLAYER minecraft:instant_health 1 10 true" >/dev/null
          rcon "effect give $PLAYER minecraft:saturation 3 10 true" ;;
clearinv) rcon "clear $PLAYER" ;;
time)     rcon "time set ${2:-night}" ;;
weather)  rcon "weather ${2:-clear}" ;;

# --- known-state snapshot / restore ------------------------------------------
snapshot)
    mkdir -p "$SNAPDIR"
    read -r X Y Z <<<"$(require_pos)" || exit 1
    { echo "POS $X $Y $Z"; echo "INV $(rcon "data get entity $PLAYER Inventory")"; } > "$SNAPDIR/${2:-default}"
    echo "saved $SNAPDIR/${2:-default} (pos $X $Y $Z)"
    ;;
restore)
    SNAP="$SNAPDIR/${2:-default}"
    [ -f "$SNAP" ] || { echo "no snapshot at $SNAP" >&2; exit 1; }
    read -r _ X Y Z <<<"$(grep '^POS ' "$SNAP")"
    require_pos >/dev/null || exit 1
    rcon "tp $PLAYER $X $Y $Z" >/dev/null
    rcon "effect give $PLAYER minecraft:instant_health 1 10 true" >/dev/null
    rcon "effect give $PLAYER minecraft:saturation 3 10 true" >/dev/null
    rcon "clear $PLAYER" >/dev/null
    # ponytail: restores item ids and counts only -- slots, damage, and
    # enchantments are lost. Full NBT re-give if a scenario ever needs it.
    grep '^INV ' "$SNAP" | tr '{' '\n' | while read -r entry; do
        id=$(echo "$entry" | grep -oE 'id: "[^"]+"' | head -1 | cut -d'"' -f2)
        n=$(echo "$entry" | grep -oE 'Count: [0-9]+b' | head -1 | grep -oE '[0-9]+')
        [ -n "$id" ] && [ -n "$n" ] && { rcon "give $PLAYER $id $n" >/dev/null; echo "gave ${n}x $id"; }
    done
    echo "restored to $X $Y $Z, healed"
    ;;

# --- mindserver socket --------------------------------------------------------
say)     shift; drive say "$@" ;;
evt)     shift; drive listen "${1:?pattern}" "${2:-90}" ;;
restart|stop|start|policy) drive "$1" ;;
# A busy agent starves the merge behind its goal-loop LLM calls until the
# relay's 600s timeout -- quiesce it first. And !stop leaves self-prompting
# alive, so the bot can !policy mid-merge, bump the revision, and get the
# merge discarded -- hold the self-write lock across the regen.
regen)   shift
    drive say '!stop' 8 >/dev/null || true
    drive lock >/dev/null || true
    rc=0; drive regen "$@" || rc=$?
    drive unlock >/dev/null || true
    exit $rc ;;
clearlayer) shift; drive clearlayer "${1:?layer}" ;;

# Which rules fired, how often -- the cheap way to see where AI turns go.
# Prompt rules show up by name; everything else firing is free.
rules)   botlog "EVT rule:fire" "${2:-30m}" | grep -oE 'rule:fire:[a-z_:0-9]+' | sort | uniq -c | sort -rn ;;

# The food story: chronological gains/losses/eats, then a tally. food:inv
# lines are inventory deltas (+found/withdrawn, -eaten/deposited/dropped);
# food:level lines are the hunger bar, ":ate" marking increases.
# Pathing story: every non-success pathfinder verdict, resets, goals reached,
# then the last stretch of breadcrumbs. Repeated noPath/timeout at the same
# spot, or breadcrumbs that stop while a goal is active, are the pathing bugs.
path)
    botlog "EVT move:(path|goal)" "${2:-30m}"
    echo "-- verdict tally:"
    botlog "EVT move:path" "${2:-30m}" | grep -oE 'move:path[a-z_]*:[a-zA-Z]+' | sort | uniq -c | sort -rn
    echo "-- last 20 breadcrumbs:"
    botlog "EVT move:pos" "${2:-30m}" | tail -20
    ;;

food)
    botlog "EVT food:" "${2:-30m}"
    echo "-- tally:"
    botlog "EVT food:inv" "${2:-30m}" | grep -oE 'food:inv:[a-z_]+:[+-][0-9]+' \
        | awk -F: '{sum[$3] += $4} END {for (i in sum) printf "  %s %+d\n", i, sum[i]}'
    ;;

# --- push code and bounce only the agent -------------------------------------
deploy)
    shift
    files=("$@")
    if [ ${#files[@]} -eq 0 ]; then
        mapfile -t files < <(git -C "$ROOT" status --porcelain \
            | awk '$1 != "D" {print $NF}' \
            | grep -E '^(src/|profiles/|policies/|settings\.js|main\.js)' || true)
    fi
    [ ${#files[@]} -eq 0 ] && { echo "nothing to deploy"; exit 0; }
    for f in "${files[@]}"; do
        case $f in *.js) node --check "$ROOT/$f" || { echo "syntax error in $f -- not deploying" >&2; exit 1; } ;; esac
    done
    echo "deploying: ${files[*]}"
    tar -C "$ROOT" -cz "${files[@]}" | ssh "$HOST" "docker exec -i $BOT_CONTAINER tar xz -C /app"
    drive restart || { echo "socket restart failed; restarting container"; ssh "$HOST" "docker restart $BOT_CONTAINER"; }
    ;;

# --- scenarios ----------------------------------------------------------------

# is_freezing reads entity metadata that a server only sends once it changes
# from its default, so absence proves nothing and the condition can only be
# confirmed by making the meter non-zero. Powder snow does that in a few
# seconds. Leather boots would stop it, and the bot has none.
freeze)
    # The first version of this just placed snow where the bot happened to be
    # and watched. It never reproduced, because the bot walks constantly and was
    # somewhere else by the time the block landed.
    #
    # So: hold it in place, and read the server's own TicksFrozen rather than
    # only the agent log. That splits the two questions apart -- does the
    # mechanic fire at all, and does mineflayer see it -- which the agent log
    # alone cannot do.
    read -r X Y Z <<<"$(require_pos)" || exit 1
    echo "penning the bot in powder snow at $X $Y $Z"
    for dx in -1 0 1; do for dz in -1 0 1; do
        rcon "setblock $((X+dx)) $((Y-1)) $((Z+dz)) packed_ice replace" >/dev/null
        rcon "setblock $((X+dx)) $Y $((Z+dz)) powder_snow replace" >/dev/null
        rcon "setblock $((X+dx)) $((Y+1)) $((Z+dz)) powder_snow replace" >/dev/null
    done; done
    seen_nbt=0
    for i in $(seq 1 24); do
        rcon "tp $PLAYER $X $Y $Z" >/dev/null
        ticks=$(rcon "data get entity $PLAYER TicksFrozen" | grep -oE '[0-9]+$' || echo 0)
        [ "${ticks:-0}" -gt 0 ] && { echo "server TicksFrozen=$ticks"; seen_nbt=1; }
        [ "${ticks:-0}" -gt 100 ] && break
        sleep 5
    done
    echo "-- server side: $([ $seen_nbt = 1 ] && echo 'freeze meter DID rise' || echo 'meter never rose; the pen did not work')"
    await "is_freezing: freeze meter is live|get_out_of_the_cold|YOU ARE FREEZING" 30 \
        && echo "-- agent side: mineflayer sees it, is_freezing is live" \
        || echo "-- agent side: NOT seen. If the meter rose server-side, metadata key 7 is the wrong index here."
    echo "-- clearing the pen"
    for dx in -1 0 1; do for dz in -1 0 1; do
        rcon "setblock $((X+dx)) $Y $((Z+dz)) air replace" >/dev/null
        rcon "setblock $((X+dx)) $((Y+1)) $((Z+dz)) air replace" >/dev/null
    done; done
    ;;

# Drops sometimes never appear at all and the cause is still unknown. Give the
# bot a tree it definitely owns, on flat ground, away from the canopy and
# pathing problems that explain the other two failure modes.
wood)
    read -r X Y Z <<<"$(require_pos)" || exit 1
    echo "bot at $X $Y $Z -- building a 5-log spruce trunk two blocks away"
    for i in 0 1 2 3 4; do rcon "setblock $((X+2)) $((Y+i)) $Z spruce_log replace"; done
    echo "-- trunk placed; watching what the agent makes of it"
    await "Collected [0-9]+ (spruce_log|log)|\[lost drops\]|yielded nothing at all" 150 || true
    ;;

# flee_ranged_raiders names its mobs as entity_nearby "name" strings, and a name
# that the client spells differently matches nothing and fails silently -- the
# exact failure mode this repo already hit with block names. The agent has been
# dying to entity.frostiful.chillager repeatedly, so check the rule actually
# fires rather than trusting the spelling.
raider)
    MOB=${2:-frostiful:chillager}
    read -r X Y Z <<<"$(require_pos)" || exit 1
    echo "summoning $MOB 10 blocks from the bot at $X $Y $Z"
    rcon "summon $MOB $((X+10)) $Y $Z"
    # The EVT carries the layer the rule lives in -- "rule:fire:active:<name>"
    # or "rule:fire:self:<name>" -- so matching on the bare name was a pattern
    # that could never hit, and reported "the rule never fired" while the log
    # showed it firing. Match either layer.
    await "EVT rule:fire:[a-z]+:flee_ranged_raiders" 90 \
        && echo "-- the rule fires: the client spells this mob the way the policy does" \
        || echo "-- rule never fired. Either the mob did not spawn, or entity_nearby's name does not match what mineflayer calls it."
    ;;

# The food chain, end to end: empty the bag, drain the hunger bar, then watch
# what feeds the bot back up. Passing = foodLevel recovers via named rules;
# any find_food/go_find_food fire in the window means it needed a paid LLM turn.
hunger)
    require_pos >/dev/null || exit 1
    foodlevel() { rcon "data get entity $PLAYER foodLevel" | grep -oE '[0-9]+' | tail -1; }
    # Daytime, clear skies: the food-search rules are idle-gated, and a night
    # full of raiders keeps the bot busy fleeing -- round one of this scenario
    # proved that tests nothing about food.
    rcon "time set day" >/dev/null; rcon "weather clear" >/dev/null
    echo "-- clearing inventory and draining hunger (foodLevel starts at $(foodlevel))"
    rcon "clear $PLAYER" >/dev/null
    rcon "effect give $PLAYER minecraft:hunger 60 250 true" >/dev/null
    for _ in $(seq 1 24); do
        f=$(foodlevel); echo "foodLevel=$f"
        [ "${f:-20}" -le 12 ] && break
        sleep 5
    done
    rcon "effect clear $PLAYER minecraft:hunger" >/dev/null
    [ "${f:-20}" -gt 12 ] && { echo "hunger never drained; effect did not take" >&2; exit 1; }
    echo "-- hunger is low; watching the food chain fire"
    await "EVT rule:fire:[a-z]+:(search_out_berries|search_out_game|take_food_from_storage|forage_|eat_)" 240 || true
    recovered=0
    for _ in $(seq 1 30); do
        f=$(foodlevel); echo "foodLevel=$f"
        [ "${f:-0}" -ge 15 ] && { recovered=1; break; }
        sleep 10
    done
    echo "-- $([ $recovered = 1 ] && echo 'RECOVERED: bot fed itself' || echo 'NOT RECOVERED in 5m')"
    echo "-- paid LLM turns during the window (want: none):"
    botlog "rule:fire:[a-z]+:(find_food_when_low|go_find_food_when_none_in_reach)|POLICY RULE" 12m || echo "   none"
    ;;

# Prove the free night path end to end. The nearby swarm is cleared first so
# the mechanics get a fair run -- the unaided version of this question is the
# long soak, not this scenario. Passing = a shelter rule fires, no paid
# shelter prompt, alive and mobile at dawn.
# NOTE on patterns: docker logs carry "EVT rule:fire:<layer>:<rule>"; the
# socket stream (evt command) carries "mode:fire:policy:<layer>:<rule>".
night)
    require_pos >/dev/null || exit 1
    for m in zombie skeleton stray spider creeper drowned husk pillager vindicator \
             ravager illusioner frostiful:chillager friendsandfoes:iceologer \
             mutantmonsters:mutant_skeleton mutantmonsters:mutant_creeper graveyard:skeleton_creeper; do
        rcon "execute at $PLAYER run kill @e[type=$m,distance=..48]" >/dev/null
    done
    rcon "give $PLAYER dirt 8" >/dev/null; rcon "give $PLAYER torch 4" >/dev/null
    rcon "time set night" >/dev/null
    echo "-- hostiles cleared, cap material given, night set; watching for the shelter chain"
    await "rule:fire:[a-z]+:(dig_in_for_the_night|wait_out_the_night_under_cover|sleep_at_night)" 300 || true
    sleep 60
    echo "-- mid-night: pos $(pos 2>/dev/null || echo '?') health $(rcon "data get entity $PLAYER Health" | grep -oE '[0-9.]+f' | tail -1)"
    echo "-- paid prompts + flee thrash over 6m (want: none):"
    botlog "POLICY RULE|rule:fire:[a-z]+:flee_ranged_raiders" 1m >/dev/null; sleep 360
    botlog "POLICY RULE|rule:fire:[a-z]+:flee_ranged_raiders" 7m || echo "   none"
    rcon "time set day" >/dev/null
    P1=$(pos 2>/dev/null); sleep 30; P2=$(pos 2>/dev/null)
    echo "-- dawn: pos $P1 -> $P2 ($([ "$P1" != "$P2" ] && echo mobile || echo 'NOT MOVING')), health $(rcon "data get entity $PLAYER Health" | grep -oE '[0-9.]+f' | tail -1)"
    ;;

watch) shift; botlog "$1" "${2:-5m}" ;;
*) sed -n '2,36p' "$0" ;;
esac
