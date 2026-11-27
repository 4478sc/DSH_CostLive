import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeEvents, usageFromEvent } from '../src/engine.mjs';
import { normalizePricing } from '../src/pricing.mjs';

// Synthetic events only: no session logs, no real prompts.
const PRICING = normalizePricing({
  models: { 'claude-sonnet-5-5': { input: 2.3, output: 11.5, cacheWrite: 2.875, cacheRead: 0.23 } },
});

let seq = 0;
function event(type, data = {}) {
  seq += 1;
  return { type, seq, time: 1700000000000 + seq * 1000, data };
}
function usage(inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}
function header(provider, model) {
  return event('request/header', { header: { config: { provider, model } } });
}
function attempt(usageValue, turn, step) {
  return event('assistant/attempt', { turn, step, stream: [{ type: 'chunk', chunk: { type: 'text', text: 'x' } }, { type: 'chunk', chunk: { type: 'usage', usage: usageValue } }] });
}
function settlement(usageValue, turn, step) {
  return event('assistant/message', { turn, step, usage: usageValue });
}
function compactionSummary(usageValue, turn = null) {
  return event('compaction/summary', { provider: 'proxy', model: 'claude-sonnet-5-5', turn, usage: usageValue });
}

test('a compaction summary is a billed call of its own', () => {
  seq = 0;
  const events = [
    header('proxy', 'claude-sonnet-5-5'),
    event('compaction/start', { turn: 1 }),
    compactionSummary(usage(1_000_000, 0)),
    event('compaction/end', { turn: 1 }),
  ];
  const result = analyzeEvents(events, PRICING);
  assert.equal(result.byModel.length, 1, 'the summary produces a model row');
  assert.equal(result.byModel[0].model, 'claude-sonnet-5-5');
  assert.equal(result.byModel[0].samples, 1);
  assert.equal(result.totals.costMicroCny, 2_300_000);
});

test('two compaction summaries in one session are both billed', () => {
  seq = 0;
  // Both summaries carry turn/step 0, so a turn/step replace rule would drop
  // the first one; a compaction row must never be a replacement target.
  const events = [
    header('proxy', 'claude-sonnet-5-5'),
    event('compaction/start', { turn: 1 }),
    compactionSummary(usage(1_000_000, 0)),
    event('compaction/end', { turn: 1 }),
    event('compaction/start', { turn: 2 }),
    compactionSummary(usage(1_000_000, 0)),
    event('compaction/end', { turn: 2 }),
  ];
  const result = analyzeEvents(events, PRICING);
  assert.equal(result.byModel[0].samples, 2);
  assert.equal(result.totals.costMicroCny, 4_600_000);
});

test('the summary route comes from the summary event, not the last chat route', () => {
  seq = 0;
  const events = [
    header('proxy', 'claude-sonnet-5-5'),
    event('compaction/start', { turn: 1 }),
    event('compaction/summary', { provider: 'other', model: 'claude-sonnet-5-5', usage: usage(1_000_000, 0) }),
  ];
  const result = analyzeEvents(events, PRICING);
  assert.equal(result.byModel[0].provider, 'other', 'route of the summary wins');
  assert.equal(result.totals.costMicroCny, 2_300_000);
});

test('an aborted attempt stays billed when a compaction separates it from the next settlement', () => {
  seq = 0;
  // Real pattern: the attempt that overflows reports usage, DSH compacts, then
  // the retry settles under the same turn/step. The provider charged both.
  const events = [
    header('proxy', 'claude-sonnet-5-5'),
    attempt(usage(1_000_000, 0), 2, 1),
    event('compaction/start', { turn: 2 }),
    compactionSummary(usage(500_000, 0), 2),
    event('compaction/end', { turn: 2 }),
    settlement(usage(10, 1), 2, 1),
  ];
  const result = analyzeEvents(events, PRICING);
  assert.equal(result.totals.samples, 3, 'attempt + summary + settlement');
  assert.equal(result.totals.tokens.uncachedInputTokens, 1_500_010);
  // 10 x 2.3 + 1 x 11.5 = 34.5 micro-CNY, rounded to 35 for the sample.
  assert.equal(result.totals.costMicroCny, 2_300_000 + 1_150_000 + 35);
});

test('a streaming attempt is still replaced by its own settlement', () => {
  seq = 0;
  const events = [
    header('proxy', 'claude-sonnet-5-5'),
    attempt(usage(1000, 10), 1, 1),
    settlement(usage(2000, 20), 1, 1),
  ];
  const result = analyzeEvents(events, PRICING);
  assert.equal(result.totals.samples, 1, 'one billed request, not two');
  assert.equal(result.totals.tokens.uncachedInputTokens, 2000);
  assert.equal(result.totals.costMicroCny, 2000 * 2.3 + 20 * 11.5);
});

test('a zero-usage compaction summary creates no row', () => {
  seq = 0;
  const events = [
    header('proxy', 'claude-sonnet-5-5'),
    event('compaction/start', { turn: 1 }),
    compactionSummary(usage(0, 0)),
  ];
  const result = analyzeEvents(events, PRICING);
  assert.equal(result.byModel.length, 0);
  assert.equal(result.totals.samples, 0);
});

test('usageFromEvent reads a compaction summary usage object', () => {
  const value = usage(10, 2);
  assert.deepEqual(usageFromEvent(event('compaction/summary', { usage: value })), value);
  assert.equal(usageFromEvent(event('compaction/summary', {})), undefined);
});
