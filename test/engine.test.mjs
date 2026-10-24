import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeEvents, usageFromEvent } from '../src/engine.mjs';
import { normalizePricing } from '../src/pricing.mjs';

const PRICING = normalizePricing({
  models: { 'claude-sonnet-5-5': { input: 2.3, output: 11.5, cacheWrite: 2.875, cacheRead: 0.23 } },
});

let seq = 0;
function event(type, data = {}) {
  seq += 1;
  return { type, seq, time: 1700000000000 + seq, data };
}
function usage(inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}
function assistantMessage(usageValue, turn = 1, step = 1) {
  return event('assistant/message', { turn, step, usage: usageValue });
}
function header(model) {
  return event('request/header', { header: { config: { provider: 'proxy', model } } });
}

test('final sample replaces the streaming sample of the same step', () => {
  seq = 0;
  const events = [
    event('model/selection', { provider: 'proxy', model: 'claude-sonnet-5-5' }),
    assistantMessage(usage(100, 10), 1, 1),
    assistantMessage(usage(120, 20), 1, 1),
    assistantMessage(usage(120, 20), 1, 1),
  ];
  const result = analyzeEvents(events, PRICING);
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.totals.tokens, { uncachedInputTokens: 120, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.equal(result.totals.samples, 1);
});

test('a retry inside one step contributes a second billed sample', () => {
  seq = 0;
  const events = [
    event('model/selection', { provider: 'proxy', model: 'claude-sonnet-5-5' }),
    assistantMessage(usage(100, 10), 1, 1),
    event('llm/retry-started', { turn: 1, step: 1 }),
    assistantMessage(usage(50, 5), 1, 1),
  ];
  const result = analyzeEvents(events, PRICING);
  assert.equal(result.records.length, 2);
  assert.equal(result.totals.tokens.uncachedInputTokens, 150);
  assert.equal(result.totals.tokens.outputTokens, 15);
});

test('attributes usage to the route active at sample time across a model switch', () => {
  seq = 0;
  const events = [
    event('model/selection', { provider: 'proxy', model: 'claude-sonnet-5-5' }),
    header('claude-sonnet-5-5'),
    assistantMessage(usage(100, 10), 1, 1),
    header('claude-haiku-5-5'),
    assistantMessage(usage(200, 20), 1, 2),
  ];
  const result = analyzeEvents(events, PRICING);
  assert.equal(result.byModel.length, 2);
  const sonnet = result.byModel.find((entry) => entry.model === 'claude-sonnet-5-5');
  const haiku = result.byModel.find((entry) => entry.model === 'claude-haiku-5-5');
  assert.equal(sonnet.costMicroCny, 345);
  assert.equal(haiku.priced, false);
  assert.equal(haiku.costMicroCny, 0);
  assert.equal(result.totals.tokens.uncachedInputTokens, 300);
});

test('zero-token settlements never create model rows or unpriced warnings', () => {
  seq = 0;
  const events = [
    event('model/selection', { provider: 'proxy', model: 'claude-haiku-5-5' }),
    assistantMessage(usage(0, 0), 1, 1),
    assistantMessage(usage(0, 0), 1, 1),
    header('claude-sonnet-5-5'),
    assistantMessage(usage(100, 10), 2, 1),
  ];
  const result = analyzeEvents(events, PRICING);
  assert.equal(result.records.length, 1);
  assert.equal(result.byModel.length, 1);
  assert.equal(result.byModel[0].model, 'claude-sonnet-5-5');
  assert.deepEqual(result.unpricedModels, []);
});

test('unknown models keep token counts but cost zero', () => {
  seq = 0;
  const events = [
    header('deepseek-v4.1-flash'),
    assistantMessage(usage(1000, 1000), 1, 1),
  ];
  const result = analyzeEvents(events, PRICING);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].priced, false);
  assert.equal(result.totals.costMicroCny, 0);
  assert.deepEqual(result.unpricedModels, ['deepseek-v4.1-flash']);
});

test('buckets include cache write and cache read at their own rates', () => {
  seq = 0;
  const events = [header('claude-sonnet-5-5'), assistantMessage(usage(1000000, 0, 1000000, 1000000), 1, 1)];
  const result = analyzeEvents(events, PRICING);
  // 1M input 2.3 + 1M cache write 2.875 + 1M cache read 0.23 = 5.405
  assert.equal(result.totals.costMicroCny, 5405000);
});

test('stream usage chunks are read from assistant/attempt', () => {
  seq = 0;
  const stream = [
    { type: 'text-chunks', texts: ['hi'] },
    { type: 'chunk', chunk: { type: 'usage', usage: usage(7, 3) } },
  ];
  const attempt = event('assistant/attempt', { turn: 1, step: 1, stream });
  assert.deepEqual(usageFromEvent(attempt), usage(7, 3));
  const result = analyzeEvents([header('claude-sonnet-5-5'), attempt], PRICING);
  assert.equal(result.totals.tokens.outputTokens, 3);
});

test('prices each sample by the clock of its own timestamp', () => {
  const tiered = normalizePricing({
    models: {
      'deepseek-v4.1-flash': {
        input: 0.15,
        output: 0.6,
        cacheWrite: 0.15,
        cacheRead: 0.003,
        peak: { input: 0.3, output: 1.2, cacheWrite: 0.3, cacheRead: 0.006 },
      },
    },
  });
  /** Beijing 10:00 Monday (peak) and 20:00 Monday (谷值). */
  const peakAt = Date.parse('2026-10-26T02:00:00Z');
  const offPeakAt = Date.parse('2026-10-26T12:00:00Z');
  const events = [
    { type: 'request/header', seq: 0, time: peakAt, data: { header: { config: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } } } },
    { type: 'assistant/message', seq: 1, time: peakAt, data: { turn: 1, step: 1, usage: usage(1000, 100) } },
    { type: 'assistant/message', seq: 2, time: offPeakAt, data: { turn: 2, step: 1, usage: usage(1000, 100) } },
  ];
  const result = analyzeEvents(events, tiered);
  // 1000×0.3 + 100×1.2 = 420 micro-CNY at peak, 1000×0.15 + 100×0.6 = 210 off-peak.
  assert.deepEqual(result.records.map((record) => record.costMicroCny), [420, 210]);
  assert.equal(result.totals.costMicroCny, 630);
  assert.deepEqual(result.unpricedModels, []);
});
