import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTokenUsage } from '../src/models/token_usage.js';

test('token usage normalizes OpenAI cached prompt tokens', () => {
    assert.deepEqual(normalizeTokenUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 64 }
    }), {
        input_total: 100,
        input_uncached: 36,
        input_cached: 64,
        output: 20,
        total: 120,
        raw: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            prompt_tokens_details: { cached_tokens: 64 }
        }
    });
});

test('token usage normalizes Anthropic cache creation and cache reads', () => {
    const usage = normalizeTokenUsage({
        input_tokens: 12,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 80,
        output_tokens: 7
    });

    assert.equal(usage.input_uncached, 42);
    assert.equal(usage.input_cached, 80);
    assert.equal(usage.output, 7);
});

test('token usage normalizes Gemini cached content tokens', () => {
    const usage = normalizeTokenUsage({
        promptTokenCount: 50,
        cachedContentTokenCount: 35,
        candidatesTokenCount: 9,
        totalTokenCount: 59
    });

    assert.equal(usage.input_uncached, 15);
    assert.equal(usage.input_cached, 35);
    assert.equal(usage.output, 9);
});
