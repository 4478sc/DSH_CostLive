import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeEvents } from '../src/engine.mjs';
import {
  DEFAULT_PEAK_HOURS,
  DEFAULT_PRICING,
  DEFAULT_PRICING_PATH,
  costCny,
  costMicroCny,
  isPeak,
  loadPricing,
  normalizePricing,
  priceAt,
  resolvePrice,
} from '../src/pricing.mjs';
import { DEFAULT_OFFICIAL_CONFIG, loadOfficialConfig, officialAnalysis } from '../src/opencode-usage.mjs';

/**
 * Official DeepSeek CNY list price per 1,000,000 tokens, read 2026-11-27 from
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ for `deepseek-flash`
 * (served by DeepSeek-V4.1-Flash-1017): off-peak (谷值) cache hit 0.02,
 * cache miss 1, output 4; peak is exactly double (0.04 / 2 / 8).
 *
 * The English page of the same table quotes USD (0.003 / 0.15 / 0.6 off-peak)
 * because it is priced in dollars. Those dollar figures once sat in this CNY
 * table and billed DeepSeek at 3/20 of its real price; this file pins the CNY
 * tariff so they cannot come back.
 */
const OFFICIAL = Object.freeze({ input: 1, output: 4, cacheWrite: 1, cacheRead: 0.02 });
const OFFICIAL_PEAK = Object.freeze({ input: 2, output: 8, cacheWrite: 2, cacheRead: 0.04 });
const FIELDS = ['input', 'output', 'cacheWrite', 'cacheRead'];

/** Synthetic sample: round buckets, not anyone's usage export. */
const SAMPLE = Object.freeze({
  uncachedInputTokens: 1_200_000,
  outputTokens: 250_000,
  cacheWriteTokens: 0,
  cacheReadTokens: 3_000_000,
});
/** 1.2 x 1 + 0.25 x 4 + 3 x 0.02 = 2.26 CNY, i.e. 2,260,000 micro-CNY. */
const SAMPLE_MICRO = 2_260_000;
const SAMPLE_PEAK_MICRO = 4_520_000;

/** Wednesday 2026-10-28 10:30 +08:00 — inside the morning peak window. */
const PEAK_AT = Date.parse('2026-10-28T02:30:00Z');
/** The same Wednesday 13:00 +08:00 — the off-peak gap between the windows. */
const OFF_AT = Date.parse('2026-10-28T05:00:00Z');

const shipped = () => loadPricing().models['deepseek-v4.1-flash'];
const buckets = (overrides = {}) => ({ ...SAMPLE, ...overrides });

test('the shipped DeepSeek entry is the official CNY valley tariff, doubled at peak', () => {
  const price = shipped();
  assert.deepEqual(priceAt(price, OFF_AT), OFFICIAL);
  assert.deepEqual(priceAt(price, PEAK_AT), OFFICIAL_PEAK);
  // Published shape: cache hit is 1/50 of a cache miss, output is 4x a miss, and
  // every peak rate is exactly twice its valley rate.
  assert.equal(price.input / price.cacheRead, 50);
  assert.equal(price.output / price.input, 4);
  for (const field of FIELDS) {
    assert.equal(price.peak[field], price[field] * 2, field);
  }
  // Regression guard: the USD-scale numbers (0.003 / 0.15 / 0.6) must not return.
  assert.notEqual(price.cacheRead, 0.003);
  assert.notEqual(price.input, 0.15);
  assert.notEqual(price.output, 0.6);
  assert.notEqual(price.peak.cacheRead, 0.006);
});

test('the built-in default table and config/pricing.json agree, peak windows unchanged', () => {
  const fromFile = loadPricing(DEFAULT_PRICING_PATH).models['deepseek-v4.1-flash'];
  const builtIn = normalizePricing(DEFAULT_PRICING).models['deepseek-v4.1-flash'];
  assert.deepEqual(builtIn, fromFile);
  // Only the four rates moved: the official peak windows are untouched.
  assert.deepEqual(fromFile.peakHours, {
    timeZone: 'Asia/Shanghai',
    weekdays: [1, 2, 3, 4, 5],
    windows: ['09:00-12:00', '14:00-18:00'],
    holidays: [],
  });
  assert.deepEqual(fromFile.peakHours, DEFAULT_PEAK_HOURS);
});

test('one synthetic sample bills to the official fen at valley and exactly double at peak', () => {
  const price = shipped();
  assert.equal(costMicroCny(buckets(), price, OFF_AT), SAMPLE_MICRO);
  assert.ok(Math.abs(costCny(buckets(), price, OFF_AT) - 2.26) < 1e-9);
  assert.equal(costMicroCny(buckets(), price, PEAK_AT), SAMPLE_PEAK_MICRO);
  assert.equal(SAMPLE_PEAK_MICRO, SAMPLE_MICRO * 2);
  // Splitting one sample into pieces only changes per-piece rounding.
  const parts = 4;
  let micro = 0;
  for (let i = 0; i < parts; i += 1) {
    const share = (value) => Math.floor(value / parts) + (i === 0 ? value % parts : 0);
    micro += costMicroCny(
      buckets({
        uncachedInputTokens: share(SAMPLE.uncachedInputTokens),
        outputTokens: share(SAMPLE.outputTokens),
        cacheReadTokens: share(SAMPLE.cacheReadTokens),
      }),
      price,
      OFF_AT,
    );
  }
  assert.ok(Math.abs(micro - SAMPLE_MICRO) <= parts, String(micro));
});

test('cache reads bill at one fiftieth of a cache miss, the unused cache-write bucket adds nothing', () => {
  const price = shipped();
  const missOnly = { uncachedInputTokens: 3_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
  const readOnly = { uncachedInputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 3_000_000 };
  // 3 x 1 = 3 CNY versus 3 x 0.02 = 0.06 CNY.
  assert.equal(costMicroCny(missOnly, price, OFF_AT), 3_000_000);
  assert.equal(costMicroCny(readOnly, price, OFF_AT), 60_000);
  assert.equal(costMicroCny(missOnly, price, OFF_AT) / costMicroCny(readOnly, price, OFF_AT), 50);
  // DeepSeek reports no cache write, so the zero bucket never changes the total.
  assert.equal(costMicroCny(buckets(), price, OFF_AT), SAMPLE_MICRO);
  // If a cache write is ever reported it is billed as an uncached input, once.
  const withWrite = buckets({ cacheWriteTokens: 500_000 });
  assert.equal(costMicroCny(withWrite, price, OFF_AT) - SAMPLE_MICRO, 500_000);
});

test('peak windows are left-closed and right-open in Beijing time', () => {
  const price = shipped();
  const peak = (iso) => isPeak(price, Date.parse(iso));
  // 2026-10-28 is a Wednesday, 2026-10-31 a Saturday, 2026-11-01 a Sunday.
  assert.equal(peak('2026-10-28T08:59:00+08:00'), false);
  assert.equal(peak('2026-10-28T09:00:00+08:00'), true);
  assert.equal(peak('2026-10-28T11:59:00+08:00'), true);
  assert.equal(peak('2026-10-28T12:00:00+08:00'), false);
  assert.equal(peak('2026-10-28T13:59:00+08:00'), false);
  assert.equal(peak('2026-10-28T14:00:00+08:00'), true);
  assert.equal(peak('2026-10-28T17:59:00+08:00'), true);
  assert.equal(peak('2026-10-28T18:00:00+08:00'), false);
  assert.equal(peak('2026-10-31T10:00:00+08:00'), false);
  assert.equal(peak('2026-11-01T10:00:00+08:00'), false);
  // A sample without a clock takes the valley rate: an unknown time never inflates.
  assert.equal(costMicroCny(buckets(), price), SAMPLE_MICRO);
});

test('a listed holiday keeps the valley rate, and the shipped table lists none', () => {
  const price = shipped();
  assert.deepEqual(price.peakHours.holidays, []);
  const withHoliday = {
    ...price,
    peakHours: { ...price.peakHours, holidays: ['2026-10-28'] },
  };
  assert.equal(isPeak(withHoliday, PEAK_AT), false);
  assert.equal(costMicroCny(buckets(), withHoliday, PEAK_AT), SAMPLE_MICRO);
});

test('every official alias resolves to the same CNY entry and the same bill', () => {
  const pricing = loadPricing();
  const price = pricing.models['deepseek-v4.1-flash'];
  for (const id of [
    'deepseek-v4.1-flash',
    'DeepSeek-V4.1-Flash',
    'deepseek-flash',
    'deepseek-v4-flash',
    'deepseek-v4-flash-vision-exp',
    'deepseek-ai/deepseek-v4.1-flash',
    'deepseek-ai/deepseek-flash',
  ]) {
    const resolved = resolvePrice(id, pricing);
    assert.equal(resolved?.key, 'deepseek-v4.1-flash', id);
    assert.equal(resolved.price, price, id);
    assert.equal(costMicroCny(buckets(), resolved.price, OFF_AT), SAMPLE_MICRO, id);
  }
});

test('a DeepSeek route bills CNY while the OpenCode overlay keeps its USD rates', () => {
  const usage = {
    inputTokens: SAMPLE.uncachedInputTokens,
    outputTokens: SAMPLE.outputTokens,
    cacheWriteTokens: 0,
    cacheReadTokens: SAMPLE.cacheReadTokens,
  };
  const route = (provider) => [
    { type: 'request/header', seq: 1, time: OFF_AT, data: { header: { config: { provider, model: 'deepseek-flash' } } } },
    { type: 'assistant/message', seq: 2, time: OFF_AT, data: { turn: 1, step: 1, usage } },
  ];

  const analysis = analyzeEvents(route('deepseek'), loadPricing());
  assert.equal(analysis.totals.costMicroCny, SAMPLE_MICRO);
  assert.equal(analysis.totals.costMicroUsd, 0);
  assert.equal(analysis.byModel[0].priceKey, 'deepseek-v4.1-flash');
  assert.equal(analysis.byModel[0].tier, 'off');
  assert.equal(analysis.byModel[0].priced, true);
  assert.deepEqual(analysis.pendingModels, []);

  // The same model on the OpenCode route is never priced from this CNY table.
  const official = analyzeEvents(route('opencode-go'), loadPricing());
  assert.equal(official.totals.costMicroCny, 0);
  assert.equal(official.byModel[0].priceKey, 'opencode-pending');
  assert.deepEqual(official.pendingModels, ['deepseek-flash']);

  // The overlay's own USD card is unchanged by this fix.
  const overlay = loadOfficialConfig(DEFAULT_OFFICIAL_CONFIG);
  assert.deepEqual(overlay.usdRates['deepseek-v4.1-flash'], {
    input: 0.162771,
    output: 0.667402,
    cacheRead: 0.002948,
  });
  const billed = officialAnalysis(
    [
      {
        id: 'req-synthetic-0001',
        provider: 'opencode-go',
        model: 'deepseek-v4.1-flash',
        startedAt: OFF_AT,
        finishedAt: OFF_AT,
        tokens: { ...SAMPLE },
        costUsd: 0.5,
      },
    ],
    { usdRates: overlay.usdRates },
  );
  assert.equal(billed.totals.costMicroCny, 0);
  assert.equal(billed.totals.costMicroUsd, 500_000);
  assert.equal(billed.byModel[0].priceKey, 'opencode-official');
});
