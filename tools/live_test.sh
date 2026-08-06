#!/usr/bin/env bash
# Drive the live agent through a scenario instead of waiting to catch one.
#
# Passive observation found real bugs in this codebase but cost hours per
# sample, and two of the hypotheses it produced were wrong. This puts the bot in
# the state under test on purpose.
#
# Usage:
#   tools/live_test.sh pos                 where is the bot
#   tools/live_test.sh rcon "<command>"    raw server command
#   tools/live_test.sh freeze              stand it in powder snow, watch is_freezing
#   tools/live_test.sh wood                give it a tree to fell, watch the drops
#   tools/live_test.sh watch <pattern> [s] tail the agent log for a pattern
#
# ponytail: bash + rcon-cli, no framework. Everything here is one server command
# and a log grep; a harness would be more code than the tests.
set -euo pipefail

HOST=${MC_HOST:-docker.lan}
MC=${MC_CONTAINER:-minecraft-prominence2}
BOT_CONTAINER=${BOT_CONTAINER:-mindcraft}
PLAYER=${MC_PLAYER:-clarkhackworth}

rcon() { ssh "$HOST" "docker exec $MC rcon-cli \"$*\"" 2>&1; }
botlog() { ssh "$HOST" "docker logs --since ${2:-2m} $BOT_CONTAINER 2>&1" | grep -E "$1" || true; }

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

# Watch for a pattern to appear, up to a deadline. Returns 1 if it never does,
# so a scenario that silently fails to reproduce is a failure, not a pass.
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
    await "policy:active:flee_ranged_raiders" 90 \
        && echo "-- the rule fires: the client spells this mob the way the policy does" \
        || echo "-- rule never fired. Either the mob did not spawn, or entity_nearby's name does not match what mineflayer calls it."
    ;;

watch) shift; botlog "$1" "${2:-5m}" ;;
*) sed -n '2,16p' "$0" ;;
esac
