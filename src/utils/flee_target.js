// Where to RUN TO when fleeing a threat, as a concrete walkable point.
//
// The bug this fixes (2026-09-07 check-in): the bot sat pinned at (-6, 46, 10)
// inside the hard NEAR_SPAWN_PIT_BOX while a drowned hovered at (-6, 68, 5) --
// 22 blocks ABOVE it. avoidEnemies re-armed `GoalInvert(GoalFollow(enemy))`
// every 500ms. GoalInvert negates the heuristic so A* cannot bound the search
// (skills.js says so out loud), and "away from something directly overhead"
// is satisfied by going DOWN -- straight into the `gravel/gravel water/water`
// floor the pit has under it. The log showed exactly that: hundreds of visited
// nodes with `at=` frozen on one block, `spin_abort`, and an identical
// `unreachable:GoalInvert:-6,68,5` on every 20s cooldown, while dig_in
// simultaneously refused ("capping where I stand"). Both escape legs aimed into
// the one direction the pit makes inescapable.
//
// Why the memo didn't save it: agent.js records a spun goal as unreachable via
// noteUnreachable(bot, g.x, g.y, g.z), but deliberately SKIPS GoalInvert (its
// coordinates are the bot's own, and blacklisting them would poison the ground
// under every other skill). So a GoalInvert-based escape is invisible to the
// 5-minute unreachable memo by construction -- it can re-fire forever. The fix
// is to hand the flee a target that HAS coordinates, so the existing memo seam
// does the memoization for free: spin once, get recorded, and the next pass
// refuses it (skills.js reads it back with isUnreachable) and degrades honestly
// instead of thrashing.
//
// The lesson is already documented in the *position* flee (moveAway): "getting
// away is a thing you do on the map", horizontal-only distance, never satisfy a
// flee by going straight up. The *entity* flee never received any of it. This
// module gives it the same rule.
//
// Pure: takes plain {x,y,z}, returns a plain ordered list of {x,y,z} (never
// throws). Deterministic -- no Math.random -- so a test can pin which heading
// comes back and the bot behaves repeatably.
import { inHardPocket } from './water_aware_path.js';

// Eight flat headings, fixed order. When the threat is directly overhead or
// underfoot the horizontal delta is ~0 and there is no single "away" -- so we
// fall back to this fan rather than a random direction, which would make the
// flee non-reproducible and non-testable.
const FAN = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/**
 * Flat (y held at the bot's level) escape points away from a threat, ordered
 * best-first. Points that land inside an unescapable hard pocket are dropped,
 * so the flee aims OUT of a pit rather than sliding along its floor or diving
 * into it. Returns [] when no flat, in-the-clear escape exists at this distance
 * -- the caller's signal that running cannot help here (fight / dig in / door).
 *
 * @param {{x:number,y:number,z:number}} pos        bot's current position.
 * @param {{x:number,y:number,z:number}} threatPos  the mob's current position.
 * @param {number} [minDistance=16]                 how far to aim, horizontally.
 * @returns {Array<{x:number,y:number,z:number}>}   ordered candidates, or [].
 */
export function fleeTargetFor(pos, threatPos, minDistance = 16) {
    if (!pos || !threatPos) return [];
    const px = Number(pos.x), py = Number(pos.y), pz = Number(pos.z);
    const tx = Number(threatPos.x), tz = Number(threatPos.z);
    if (![px, py, pz, tx, tz].every(Number.isFinite)) return [];

    // Horizontal away from the threat. A threat directly overhead/underfoot has
    // ~no horizontal delta, so there is no meaningful primary heading there --
    // adding it would just duplicate a fan direction. Only the horizontal delta
    // matters: the vertical component is exactly the pull that made the bot dive.
    const ax = px - tx, az = pz - tz;
    const mag = Math.hypot(ax, az);
    const dirs = [];
    if (mag >= 0.5) dirs.push([ax / mag, az / mag]);
    for (const d of FAN) dirs.push(d);

    const d = Math.max(1, minDistance);
    const out = [];
    const seen = new Set();
    for (const [ux, uz] of dirs) {
        const x = Math.floor(px + ux * d);
        const z = Math.floor(pz + uz * d);
        const key = x + ',' + z;
        if (seen.has(key)) continue;
        seen.add(key);
        // y is the bot's own level, floored: a flee is a map move, not a dive.
        out.push({ x, y: Math.floor(py), z });
    }

    // Prefer candidates that are NOT inside a hard pocket. A flat escape that
    // leaves the pit beats one that runs along its floor into a corner. If every
    // flat heading stays inside the pocket (a bot deep in the flooded cave ring),
    // running on the level genuinely cannot help -- say so by returning [].
    const clear = out.filter((c) => !inHardPocket(c));
    return clear;
}
