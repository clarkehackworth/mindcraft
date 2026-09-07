#!/usr/bin/env bash
# One soak sample, appended to a log. No Claude, no session, no cron job living
# in somebody's chat history.
#
# The soak ran for two days off a cron job that existed only inside a Claude
# session: when the session ended, so did the record. This is the half that does
# not need a model -- collecting -- so it can run from host cron or a systemd
# timer and still be there tomorrow. Reading the log and deciding what it means
# is the half that does.
#
#   */30 * * * * /home/jeff/dev/mindcraft/tools/soak_watch.sh >> /var/log/andy-soak.log 2>&1
#
# Then: tools/soak_watch.sh report [file]   -- deltas across the samples so far
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
HOST=${MC_HOST:-docker.lan}
MC=${MC_CONTAINER:-minecraft-prominence2}
BOT=${BOT_CONTAINER:-mindcraft}
PLAYER=${MC_PLAYER:-clarke_hackworth}
WINDOW=${SOAK_WINDOW:-30m}

# `scorecard [log]`: one row per deployed sha -- samples, deaths, paid turns,
# noPath, goals. Windows are 30m samples of a 30m log, so sums are totals.
if [ "${1:-sample}" = scorecard ]; then
    awk -F'\t' '
        /^ts=/ { delete cur; for (i=1;i<=NF;i++) { split($i,kv,"="); cur[kv[1]]=kv[2] }
                 s=cur["sha"]; if (s=="") s="?"; if (!(s in first)) { first[s]=cur["ts"]; order[++n]=s }
                 last[s]=cur["ts"]; cnt[s]++; d[s]+=cur["deaths"]; p[s]+=cur["paid"]; np[s]+=cur["nopath"]; g[s]+=cur["goals"] }
        END { printf "%-16s %-20s %-20s %7s %7s %7s %8s %8s %6s\n","sha","first","last","samples","deaths","paid","deaths/h","paid/h","goals"
              for (i=1;i<=n;i++) { s=order[i]; h=cnt[s]/2; printf "%-16s %-20s %-20s %7d %7d %7d %8.2f %8.1f %6d\n", s, first[s], last[s], cnt[s], d[s], p[s], d[s]/h, p[s]/h, g[s] } }
    ' "${2:-/var/log/andy-soak.log}"
    exit 0
fi
if [ "${1:-sample}" = report ]; then
    # Deltas between consecutive samples, which is what the check actually asks
    # for. Reading raw samples means doing this subtraction by eye every time.
    awk -F'\t' '
        /^ts=/ { for (i=1;i<=NF;i++) { split($i,kv,"="); cur[kv[1]]=kv[2] }
                 if (seen) {
                     printf "%s  deaths %s (%+d)  goals %s (%+d)  stuck %s  y=%s food=%s hp=%s\n",
                         cur["ts"], cur["deaths"], cur["deaths"]-prev["deaths"],
                         cur["goals"],  cur["goals"]-prev["goals"],
                         cur["pathstuck"], cur["y"], cur["food"], cur["hp"]
                     if (cur["falls"]+0 > 0) printf "    FALLS: %s\n", cur["falls"]
                     if (cur["unresolved"] != "" && cur["unresolved"] != "-") printf "    spinning: %s\n", cur["unresolved"]
                 }
                 for (k in cur) prev[k]=cur[k]; seen=1 }
    ' "${2:-/var/log/andy-soak.log}"
    exit 0
fi

q() { ssh "$HOST" "docker exec $MC rcon-cli \"$*\"" 2>/dev/null | grep -oE '\-?[0-9]+\.?[0-9]*' | tail -1; }
# tail + own-timestamp filter: `docker logs --since` returns nothing on this daemon (see live_test.sh rawlog)
since=$(date -u -d "-$(echo "$WINDOW" | sed -E 's/([0-9]+)m$/\1 min/; s/([0-9]+)h$/\1 hour/')" +%FT%TZ)
log=$(ssh "$HOST" "docker logs -t --tail 120000 $BOT 2>&1" | tr -d '\r' | awk -v s="$since" '$1 >= s' | cut -d' ' -f2-)
sha=$(ssh "$HOST" "docker exec $BOT cat /app/DEPLOY_SHA 2>/dev/null" || true)
c() { printf '%s' "$log" | grep -acE "$1" || true; }

pos=$(ssh "$HOST" "docker exec $MC rcon-cli \"data get entity $PLAYER Pos\"" 2>/dev/null \
      | grep -oE '\-?[0-9]+\.[0-9]+' | head -3 | tr '\n' ',' | sed 's/,$//' || true)
# Both fall keys: death.fell is falling off something, death.attack.fall is
# hitting the ground after being knocked up. Matching only the first reported
# zero for a window that had a fall death.
printf 'ts=%s\tsha=%s\tpaid=%s\tnopath=%s\tpos=%s\ty=%s\thp=%s\tfood=%s\tdeaths=%s\tfalls=%s\tgoals=%s\tpathstuck=%s\terrors=%s\tunresolved=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "${sha:-?}" \
    "$(c 'Awaiting .* api response')" \
    "$(c 'noPath')" \
    "${pos:-?}" \
    "$(printf '%s' "${pos:-?}" | cut -d, -f2 | cut -d. -f1)" \
    "$(q "data get entity $PLAYER Health")" \
    "$(q "data get entity $PLAYER foodLevel")" \
    "$(c 'EVT death:')" \
    "$(c 'death\.(fell|attack\.fall)')" \
    "$(c 'move:goal_reached')" \
    "$(c 'path_reset:stuck')" \
    "$(c 'unhandled|fatal|Error:')" \
    "$(printf '%s' "$log" | grep -oE 'rule:(stuck|unresolved):[a-z_0-9:]+:[0-9]+' \
        | sed -E 's/:[0-9]+$//' | sort -u | tr '\n' ' ' | sed 's/ $//' || echo -)"
