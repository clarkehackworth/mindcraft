import test from 'node:test';
import assert from 'node:assert/strict';
import { stringifyTurns } from '../src/utils/text.js';

test('memory summary text includes native tool calls and tool results', () => {
    const summaryInput = stringifyTurns([
        { role: 'user', content: 'collect wood' },
        {
            role: 'assistant',
            content: '',
            native_tool_calls: [{
                id: 'call_1',
                type: 'function',
                name: 'collectBlocks',
                arguments: '{"type":"oak_log","num":2}'
            }]
        },
        { role: 'tool', tool_call_id: 'call_1', name: 'collectBlocks', content: 'Action output:\nCollected 2 oak_log.' }
    ]);

    assert.match(summaryInput, /User input: collect wood/);
    assert.match(summaryInput, /Tool call \(collectBlocks\): \{"type":"oak_log","num":2\}/);
    assert.match(summaryInput, /Tool result \(collectBlocks\): Action output:\nCollected 2 oak_log\./);
    assert.doesNotMatch(summaryInput, /\*used collectBlocks\*/);
});
