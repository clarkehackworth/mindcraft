// Validate every policy the agent can actually load, against the same
// validatePolicy the agent runs at startup.
//
// The 2026-09-04 incident: one rule in bots/Andy/policy.json used string-prefix
// negation ("cond": "not is_sheltered"). In this language `not` is an object
// combinator -- { "not": { "cond": ... } } -- so the validator rejected the rule,
// and the validator treats ANY invalid rule as making the whole layer invalid.
// Result: the bot's entire active layer (80 rules: arming, gate, flee, shelter)
// was silently discarded at load. No crash, no error on the bot's screen -- just
// a bot that could no longer survive. Nothing validated the live policy file
// before deploy; this is the check that catches that class.
//
// It validates BOTH sources because the regen path (tools/live_*.sh regen) rebuilds
// a live active layer from a base policy -- a bad rule in policies/*.json would
// reappear on the next regen even after the live file is fixed.
//
// Run: node tools/policy_file_check.js   (exit 0 = all valid)
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { validatePolicy, CONDITIONS } from '../src/agent/behavior/policy.js';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const botsDir = path.join(root, 'bots');
const baseDir = path.join(root, 'policies');

// Collect (label, policyObject) pairs.
const targets = [];
for (const entry of fs.readdirSync(botsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const policyPath = path.join(botsDir, entry.name, 'policy.json');
    if (!fs.existsSync(policyPath)) continue;
    const doc = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    if (doc.layers) {
        for (const layerName of Object.keys(doc.layers)) {
            targets.push([`${entry.name}/${layerName}`, doc.layers[layerName].policy]);
        }
    } else {
        targets.push([`${entry.name}/<top-level>`, doc.policy || doc]);
    }
}
for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const doc = JSON.parse(fs.readFileSync(path.join(baseDir, entry.name), 'utf8'));
    targets.push([`base/${entry.name}`, doc.policy || doc]);
}

let layers = 0, bad = 0;
for (const [label, policy] of targets) {
    if (!policy || !Array.isArray(policy.rules)) continue;
    layers++;
    const err = validatePolicy(policy);
    if (err) {
        bad++;
        console.error(`FAIL ${label}: ${err}`);
        continue;
    }
    // Belt-and-braces: walk every condition the validator accepted and name any
    // cond the CONDITIONS table does not know. Catches a condition typo that a
    // combinators-only failure could mask.
    const used = new Set();
    const walk = (c) => {
        if (!c || typeof c !== 'object') return;
        if (typeof c.cond === 'string') used.add(c.cond);
        (c.all || []).forEach(walk);
        (c.any || []).forEach(walk);
        if (c.not) walk(c.not);
    };
    for (const r of policy.rules) walk(r.when);
    const unknown = [...used].filter((c) => !CONDITIONS[c]);
    if (unknown.length) {
        bad++;
        console.error(`FAIL ${label}: unknown condition(s) ${unknown.join(', ')}`);
    } else {
        console.log(`ok   ${label}: ${policy.rules.length} rules valid`);
    }
}
assert.ok(layers > 0, 'no policy layers found');
assert.equal(bad, 0, `${bad} invalid policy layer(s)`);
console.log(`PASS: ${layers} layer(s), 0 invalid`);
