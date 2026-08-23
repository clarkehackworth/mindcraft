// Run: node src/agent/commands/tool_defs.test.js
// The tool-calling bridge: command registry -> typed tool schemas, and a tool
// call -> the `!name(...)` text the parser already speaks. If serialization
// drifts from the regex protocol, tool calling silently produces commands the
// parser drops -- so pin the round trip.
import assert from 'assert';
import registryLoader from 'prismarine-registry';
import { useRegistry } from '../../utils/mcdata.js';
import { getToolDefs, serializeToolCall, containsCommand, parseCommandMessage } from './index.js';

useRegistry(registryLoader('1.20.1')); // parseCommandMessage validates block/item names

const agent = { name: 'testbot', blocked_actions: [] };
const tools = getToolDefs(agent);

assert.ok(tools.length > 20, `expected a real tool list, got ${tools.length}`);
for (const t of tools) {
    assert.ok(!t.name.startsWith('!'), `tool names are bare: ${t.name}`);
    assert.equal(t.input_schema.type, 'object');
    for (const p of Object.values(t.input_schema.properties))
        assert.ok(['string', 'number', 'integer', 'boolean'].includes(p.type), `json type: ${p.type}`);
}
console.log('ok: every command renders as a well-formed tool schema');

// The schema has to survive JSON.stringify, which is how it reaches the model.
// Many command domains are [0, Infinity] or [-Infinity, Infinity], and
// stringify renders Infinity as null -- llama.cpp answers that with
// "type must be number, but is null" and EVERY generation fails. This cost a
// live bot its brain for two minutes; a null anywhere in the payload is the
// cheapest possible thing to assert.
{
    const wire = JSON.stringify(tools);
    assert.ok(!wire.includes('null'), 'no null may reach the model in a tool schema');
    const reparsed = JSON.parse(wire);
    for (const t of reparsed) {
        for (const [pname, p] of Object.entries(t.input_schema.properties)) {
            for (const bound of ['minimum', 'maximum']) {
                if (bound in p) assert.ok(Number.isFinite(p[bound]),
                    `${t.name}.${pname}.${bound} must be a finite number, got ${p[bound]}`);
            }
        }
    }
}
console.log('ok: no infinities or nulls survive into the wire schema');

// Round trip: serialized calls must parse back through the regex protocol.
const cases = [
    ['collectBlocks', { type: 'oak_log', num: 5 }],
    ['goToCoordinates', { x: 1.5, y: -60, z: 8, closeness: 1 }],
    ['stats', {}],
];
for (const [name, input] of cases) {
    const text = serializeToolCall(name, input);
    assert.equal(containsCommand(text), '!' + name, `parser must find the command in: ${text}`);
    const parsed = parseCommandMessage(text);
    assert.ok(typeof parsed !== 'string', `args must parse cleanly: ${text} -> ${parsed}`);
}
console.log('ok: serialized tool calls survive the regex parser round trip');

// The OpenAI envelope: same schema, wrapped in a function object. Andy runs a
// GPT model, so this is the mapping that is actually live -- pin it here
// rather than discovering a shape error as an API rejection mid-soak.
{
    const { toOpenAITools } = await import('../../models/gpt.js');
    const mapped = toOpenAITools(tools);
    assert.equal(mapped.length, tools.length);
    for (const m of mapped) {
        assert.equal(m.type, 'function');
        assert.ok(m.function.name && !m.function.name.startsWith('!'), 'bare name inside the envelope');
        assert.equal(m.function.parameters.type, 'object', 'parameters must be the JSON schema itself');
        assert.ok(!('input_schema' in m.function), 'anthropic key must not leak through');
    }
}
console.log('ok: tools map into the OpenAI function envelope');

// Embedded double quotes cannot be escaped in this protocol; they must be
// replaced, not passed through to break the parse.
const tricky = serializeToolCall('remember', { fact: 'the "grave" mod eats items' });
assert.equal(containsCommand(tricky), '!remember');
assert.ok(typeof parseCommandMessage(tricky) !== 'string', `quotes must not break parsing: ${tricky}`);
console.log('ok: unescapable quotes are neutralized');
