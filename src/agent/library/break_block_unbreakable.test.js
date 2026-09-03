import { strict as assert } from 'node:assert';
import Vec3 from 'vec3';
import { breakBlockAt } from './skills.js';

// The Infinity-dig gate in breakBlockAt. The live failure it exists for: the
// base pocket is barrier-filled, barrier passes canHarvest for every tool, so
// the old tool check never ran, and the dig sailed into mineflayer, which threw
// "dig time ... is Infinity" straight up through digDown into the dig_in rule.
// That rule then re-fired on cooldown all night (10 failures in one window)
// without ever sheltering the bot. The gate refuses any block whose dig time
// is not finite, before the dig is ever attempted.
//
// The fake bot is deliberately missing startDigging and friends: if any case
// below ever reaches the real dig, that is an unhandled throw and the check
// fails. That is the sentinel.
function fakeBot({ digTime, canHarvest = () => true, footring = null } = {}) {
    const target = new Vec3(1, 63, 0);
    return {
        output: '',
        game: { gameMode: 'survival' },
        modes: { isOn: () => false },
        entity: { position: new Vec3(0, 63, 0), isInWater: false },
        heldItem: { type: 'diamond_pickaxe' },
        tool: { equipForBlock: async () => {} },
        blockAt(pos) {
            if (pos.x === 1 && pos.y === 63 && pos.z === 0) {
                return {
                    name: 'barrier',
                    position: target,
                    boundingBox: 'block',
                    canHarvest: (id) => canHarvest(id),
                };
            }
            // Foothold ring: a solid neighbour means wouldMaroon is false;
            // null everywhere means the target is the last foothold.
            return footring === 'solid' ? { name: 'stone', position: pos, boundingBox: 'block' } : null;
        },
        digTime,
    };
}

// 1. The barrier case: dig time Infinity, canHarvest lies true (as it does for
//    real barrier). Refused, no dig reached, and the refusal says why.
{
    const bot = fakeBot({ digTime: () => Infinity, canHarvest: () => true });
    const ok = await breakBlockAt(bot, 1, 63, 0);
    assert.equal(ok, false, 'an unbreakable block is refused, not dug');
    assert.match(bot.output, /Refusing to break barrier/, 'the refusal names the block and the reason');
    assert.doesNotMatch(bot.output, /Broke barrier/, 'no success log');
}

// 2. A finite dig time still passes the new gate: a slow-but-possible dig with
//    the wrong tool falls through to the old tools refusal, exactly as before.
{
    const bot = fakeBot({ digTime: () => 5000, canHarvest: () => false });
    const ok = await breakBlockAt(bot, 1, 63, 0);
    assert.equal(ok, false, 'wrong tool still refuses');
    assert.match(bot.output, /Don't have right tools/, 'the refusal is the tools check, not the dig-time gate');
    assert.doesNotMatch(bot.output, /Refusing to break/, 'the new gate did not fire for a finite dig time');
}

// 3. digTime throwing degrades to a clean refuse, not a throw into the rule or
//    tick path. The gate is the last line before the dig and it must hold even
//    when the time itself cannot be computed.
{
    const bot = fakeBot({ digTime: () => { throw new Error('exotic block, no time'); } });
    const ok = await breakBlockAt(bot, 1, 63, 0);
    assert.equal(ok, false, 'an uncomputable dig time is refused, not thrown');
    assert.match(bot.output, /Refusing to break barrier/, 'it degrades to the same refusal');
}

// 4. Full pass-through: a fast dig the caller allows dropless passes both gates
//    and reaches the maroon guard (the target is the last foothold here), which
//    refuses cleanly. Proves the gate does not over-refuse the digs it must let
//    through -- the descent and shelter digging still work.
{
    const bot = fakeBot({ digTime: () => 500, canHarvest: () => false });
    const ok = await breakBlockAt(bot, 1, 63, 0, /* allowNoDrop */ true);
    assert.equal(ok, false, 'the maroon guard still refuses the last foothold');
    assert.match(bot.output, /last block you could step onto/, 'reached the maroon guard, so both earlier gates passed');
}

console.log('ok: breakBlockAt refuses unbreakable blocks before the dig, and still lets finite digs through');
