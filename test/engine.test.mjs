import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeEvents, usageFromEvent } from '../src/engine.mjs';
import { normalizePricing, normalizeUsdPricing } from '../src/pricing.mjs';
import { averageTokenPrice } from '../src/money.mjs';

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

const TIERED = normalizePricing({
  models: {
    'deepseek-v4.1-flash': {
      input: 0.15,
      output: 0.6,
      cacheWrite: 0.15,
      cacheRead: 0.003,
      peak: { input: 0.3, output: 1.2, cacheWrite: 0.3, cacheRead: 0.006 },
      peakHours: { timeZone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5], windows: ['09:00-12:00', '14:00-18:00'], holidays: [] },
    },
  },
});

test('two-tier models produce separate peak and off-peak rows', () => {
  // 2026-10-26 is a Monday: 10:00 +08:00 is peak, 20:00 +08:00 is off-peak.
  const peakTime = Date.parse('2026-10-26T02:00:00Z');
  const offTime = Date.parse('2026-10-26T12:00:00Z');
  const events = [
    { type: 'model/selection', seq: 1, time: peakTime, data: { provider: 'proxy', model: 'deepseek-v4.1-flash' } },
    { type: 'assistant/message', seq: 2, time: peakTime, data: { turn: 1, step: 1, usage: usage(1000000, 0) } },
    { type: 'assistant/message', seq: 3, time: offTime, data: { turn: 1, step: 2, usage: usage(1000000, 0) } },
  ];
  const result = analyzeEvents(events, TIERED);
  assert.equal(result.byModel.length, 2);
  const peak = result.byModel.find((entry) => entry.tier === 'peak');
  const off = result.byModel.find((entry) => entry.tier === 'off');
  assert.ok(peak && off, 'both tiers present');
  assert.equal(peak.costMicroCny, 300000);
  assert.equal(off.costMicroCny, 150000);
  assert.equal(peak.priceKey, off.priceKey);
});

test('official rows also carry the peak/off tier from the same windows', () => {
  const peakTime = Date.parse('2026-10-26T02:00:00Z');
  const events = [
    { type: 'model/selection', seq: 1, time: peakTime, data: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
    { type: 'assistant/message', seq: 2, time: peakTime, data: { turn: 1, step: 1, usage: usage(10, 1) } },
  ];
  const result = analyzeEvents(events, TIERED);
  assert.equal(result.byModel.length, 1);
  assert.equal(result.byModel[0].tier, 'peak');
  assert.equal(result.byModel[0].priced, false);
});

const USD_PRICING = normalizeUsdPricing({
  providers: ['codex', 'openai', 'host-codex'],
  models: { 'gpt-6.1-sol': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 } },
});

test('codex models are costed from the USD list price, not the CNY table', () => {
  seq = 0;
  const events = [
    event('model/selection', { provider: 'codex', model: 'gpt-6.1-sol' }),
    assistantMessage(usage(1_000_000, 1_000_000), 1, 1),
  ];
  const result = analyzeEvents(events, PRICING, USD_PRICING);
  assert.equal(result.totals.costMicroCny, 0);
  assert.equal(result.totals.costMicroUsd, 12_000_000);
  const row = result.byModel[0];
  assert.equal(row.priceKey, 'usd-gpt-6.1-sol');
  assert.equal(row.priced, true);
  assert.equal(row.costMicroUsd, 12_000_000);
  assert.deepEqual(result.unpricedModels, []);
});

test('the USD table only prices the providers it lists', () => {
  seq = 0;
  const events = [
    event('model/selection', { provider: 'aicodemirror1', model: 'gpt-6.1-sol' }),
    assistantMessage(usage(1000, 100), 1, 1),
  ];
  const result = analyzeEvents(events, PRICING, USD_PRICING);
  assert.equal(result.byModel[0].priced, false);
  assert.equal(result.totals.costMicroUsd, 0);
  assert.deepEqual(result.unpricedModels, ['gpt-6.1-sol']);
});

test('USD-priced rows join the USD token-price average', () => {
  const average = averageTokenPrice([
    {
      model: 'gpt-6.1-sol',
      priceKey: 'usd-gpt-6.1-sol',
      priced: true,
      costMicroCny: 0,
      costMicroUsd: 4_000_000,
      tokens: { uncachedInputTokens: 2_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
    },
  ]);
  assert.equal(average.cnyTokens, 0);
  assert.equal(average.usdTokens, 2_000_000);
  assert.equal(average.usdMicroPerM, 2_000_000);
});

test('openai and host-codex rows fold into the codex provider', () => {
  seq = 0;
  const events = [
    event('model/selection', { provider: 'codex', model: 'gpt-6.1-sol' }),
    assistantMessage(usage(1000, 100), 1, 1),
    event('model/selection', { provider: 'openai', model: 'gpt-6.1-sol' }),
    assistantMessage(usage(2000, 200), 1, 2),
    event('model/selection', { provider: 'host-codex', model: 'gpt-6.1-sol' }),
    assistantMessage(usage(3000, 300), 1, 3),
  ];
  const result = analyzeEvents(events, PRICING, USD_PRICING);
  assert.equal(result.byModel.length, 1, 'one row for all three routes');
  assert.equal(result.byModel[0].provider, 'codex');
  assert.equal(result.byModel[0].tokens.uncachedInputTokens, 6000);
  assert.equal(result.byModel[0].tokens.outputTokens, 600);
  // 6000 x \$2/M + 600 x \$10/M = \$0.018
  assert.equal(result.byModel[0].costMicroUsd, 18000);
});

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

test('opencode providers are pending official billing, never CNY estimates', () => {
  seq = 0;
  const tiered = normalizePricing({
    models: { 'deepseek-v4.1-flash': { input: 0.15, output: 0.6, cacheWrite: 0.15, cacheRead: 0.003 } },
  });
  const events = [
    event('model/selection', { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }),
    assistantMessage(usage(1000, 100)),
  ];
  const result = analyzeEvents(events, tiered);
  assert.equal(result.totals.costMicroCny, 0);
  assert.deepEqual(result.records.map((record) => record.costMicroCny), [0]);
  assert.equal(result.records[0].priceKey, 'opencode-pending');
  assert.equal(result.records[0].priced, false);
  assert.deepEqual(result.unpricedModels, []);
  assert.deepEqual(result.pendingModels, ['deepseek-v4.1-flash']);
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
    { type: 'request/header', seq: 0, time: peakAt, data: { header: { config: { provider: 'deepseek', model: 'deepseek-v4.1-flash' } } } },
    { type: 'assistant/message', seq: 1, time: peakAt, data: { turn: 1, step: 1, usage: usage(1000, 100) } },
    { type: 'assistant/message', seq: 2, time: offPeakAt, data: { turn: 2, step: 1, usage: usage(1000, 100) } },
  ];
  const result = analyzeEvents(events, tiered);
  // 1000×0.3 + 100×1.2 = 420 micro-CNY at peak, 1000×0.15 + 100×0.6 = 210 off-peak.
  assert.deepEqual(result.records.map((record) => record.costMicroCny), [420, 210]);
  assert.equal(result.totals.costMicroCny, 630);
  assert.deepEqual(result.unpricedModels, []);
});
