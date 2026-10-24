import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PRICING,
  DEFAULT_PRICING_PATH,
  costCny,
  costMicroCny,
  describePeakHours,
  formatCny,
  isPeak,
  loadPricing,
  normalizePricing,
  priceAt,
  resolvePrice,
} from '../src/pricing.mjs';

const PRICING = normalizePricing({
  currency: 'CNY',
  unitTokens: 1000000,
  models: {
    'claude-sonnet-5-5': { input: 2.3, output: 11.5, cacheWrite: 2.875, cacheRead: 0.23 },
    'claude-opus-*': { input: 10, output: 20, cacheWrite: 12, cacheRead: 1 },
  },
  aliases: { 'claude-sonnet-5.5': 'claude-sonnet-5-5' },
});

/** Beijing 10:00 Monday — inside the morning peak window. */
const PEAK_AT = Date.parse('2026-10-26T02:00:00Z');
/** Beijing 20:00 the same Monday — off-peak (谷值). */
const OFF_PEAK_AT = Date.parse('2026-10-26T12:00:00Z');
/** Beijing 10:00 Sunday — off-peak despite the hour. */
const WEEKEND_AT = Date.parse('2026-10-25T02:00:00Z');

const TIERED = normalizePricing({
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

test('resolves exact, prefixed, dated, and aliased model ids', () => {
  for (const id of [
    'claude-sonnet-5-5',
    'anthropic/claude-sonnet-5-5',
    'claude-sonnet-5-5-20260101',
    'claude-sonnet-5.5',
    'CLAUDE-SONNET-5-5',
  ]) {
    const resolved = resolvePrice(id, PRICING);
    assert.equal(resolved?.key, 'claude-sonnet-5-5', id);
  }
});

test('resolves wildcard prefixes and rejects unknown models', () => {
  assert.equal(resolvePrice('claude-opus-5-5', PRICING)?.key, 'claude-opus-*');
  assert.equal(resolvePrice('deepseek-v4.1-flash', PRICING), null);
  assert.equal(resolvePrice('', PRICING), null);
});

test('costs one million tokens of each bucket exactly', () => {
  const price = PRICING.models['claude-sonnet-5-5'];
  const buckets = { uncachedInputTokens: 1000000, outputTokens: 1000000, cacheWriteTokens: 1000000, cacheReadTokens: 1000000 };
  assert.equal(costMicroCny(buckets, price), 16905000);
  assert.equal(costCny(buckets, price), 16.905);
});

test('micro-CNY arithmetic stays exact for a real session total', () => {
  const price = PRICING.models['claude-sonnet-5-5'];
  const buckets = { uncachedInputTokens: 14053, outputTokens: 2241, cacheWriteTokens: 52539, cacheReadTokens: 42086 };
  // 14053*2.3 + 2241*11.5 + 52539*2.875 + 42086*0.23 = 32321.9 + 25771.5 + 151049.625 + 9679.78
  assert.equal(costMicroCny(buckets, price), 218823);
  assert.equal(costCny(buckets, price), 0.218823);
});

test('rejects malformed price documents', () => {
  assert.throws(() => normalizePricing({ models: {} }), /non-empty/u);
  assert.throws(() => normalizePricing({ models: { x: { input: -1, output: 1, cacheWrite: 1, cacheRead: 1 } } }), /non-negative/u);
  assert.throws(() => normalizePricing({ models: { x: { input: 1 } } }), /output/u);
});

test('formats micro amounts with visible precision', () => {
  assert.equal(formatCny(0.218823), '¥0.2188');
  assert.equal(formatCny(0.000123), '¥0.000123');
  assert.equal(formatCny(16.905), '¥16.9050');
  assert.equal(formatCny(1234.5), '¥1234.50');
});

test('prices the shipped DeepSeek V4.1 Flash entry and its official aliases', () => {
  const pricing = loadPricing(DEFAULT_PRICING_PATH);
  for (const id of [
    'deepseek-v4.1-flash',
    'DeepSeek-V4.1-Flash',
    'deepseek-flash',
    'deepseek-v4-flash',
    'deepseek-v4-flash-vision-exp',
    'deepseek-ai/deepseek-v4.1-flash',
    'opencode-go/deepseek-v4.1-flash',
  ]) {
    assert.equal(resolvePrice(id, pricing)?.key, 'deepseek-v4.1-flash', id);
  }
  const price = pricing.models['deepseek-v4.1-flash'];
  assert.deepEqual([price.input, price.output, price.cacheWrite, price.cacheRead], [0.15, 0.6, 0.15, 0.003]);
  assert.deepEqual(price.peak, { input: 0.3, output: 1.2, cacheWrite: 0.3, cacheRead: 0.006 });
  assert.equal(describePeakHours(price), 'Asia/Shanghai 周一至周五 09:00-12:00、14:00-18:00');
});

test('the built-in fallback table matches config/pricing.json', () => {
  assert.deepEqual(normalizePricing(DEFAULT_PRICING), loadPricing(DEFAULT_PRICING_PATH));
});

test('a two-tier price picks its tier from the sample clock', () => {
  const price = TIERED.models['deepseek-v4.1-flash'];
  assert.equal(isPeak(price, PEAK_AT), true);
  assert.equal(isPeak(price, OFF_PEAK_AT), false);
  assert.equal(isPeak(price, WEEKEND_AT), false);
  assert.deepEqual(priceAt(price, PEAK_AT), { input: 0.3, output: 1.2, cacheWrite: 0.3, cacheRead: 0.006 });
  assert.deepEqual(priceAt(price, OFF_PEAK_AT), { input: 0.15, output: 0.6, cacheWrite: 0.15, cacheRead: 0.003 });
  // A flat price (no peak tier) ignores the clock, as before.
  assert.equal(isPeak(PRICING.models['claude-sonnet-5-5'], PEAK_AT), false);
});

test('two-tier arithmetic doubles at peak and defaults to the valley rate', () => {
  const price = TIERED.models['deepseek-v4.1-flash'];
  const buckets = { uncachedInputTokens: 1000000, outputTokens: 1000000, cacheWriteTokens: 0, cacheReadTokens: 1000000 };
  assert.equal(costMicroCny(buckets, price, PEAK_AT), 1506000);
  assert.equal(costMicroCny(buckets, price, OFF_PEAK_AT), 753000);
  // Without a timestamp the default (valley) price wins: never over-estimate.
  assert.equal(costMicroCny(buckets, price), 753000);
  assert.equal(costCny(buckets, price, PEAK_AT), 1.506);
});

test('peak windows accept overrides and reject malformed tiers', () => {
  const price = normalizePricing({
    models: {
      x: {
        input: 1,
        output: 2,
        cacheWrite: 1,
        cacheRead: 0.1,
        peak: { input: 2, output: 4, cacheWrite: 2, cacheRead: 0.2 },
        peakHours: { timeZone: 'UTC', weekdays: [1], windows: ['00:00-23:59'], holidays: ['2026-12-25'] },
      },
    },
  }).models.x;
  assert.equal(isPeak(price, Date.parse('2026-10-26T05:00:00Z')), true);
  assert.equal(isPeak(price, Date.parse('2026-10-27T05:00:00Z')), false);
  assert.equal(isPeak(price, Date.parse('2026-12-25T05:00:00Z')), false);
  assert.throws(
    () => normalizePricing({ models: { y: { input: 1, output: 1, cacheWrite: 1, cacheRead: 1, peak: { input: 2, output: 2, cacheWrite: 2, cacheRead: 2 }, peakHours: { windows: ['9-12'] } } } }),
    /09:00-12:00/u,
  );
  assert.throws(
    () => normalizePricing({ models: { y: { input: 1, output: 1, cacheWrite: 1, cacheRead: 1, peak: { input: 2, output: 2, cacheWrite: 2, cacheRead: 2 }, peakHours: { weekdays: [0] } } } }),
    /weekdays/u,
  );
  assert.throws(() => normalizePricing({ models: { y: { input: 1, output: 1, cacheWrite: 1, cacheRead: 1, peakHours: {} } } }), /peak/u);
});
