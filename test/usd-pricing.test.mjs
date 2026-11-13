import test from 'node:test';
import assert from 'node:assert/strict';
import { renderModels } from '../src/report-text.mjs';
import { analyzeEvents } from '../src/engine.mjs';
import {
  DEFAULT_USD_LONG_CONTEXT_THRESHOLD,
  costMicroUsd,
  loadUsdPricing,
  normalizePricing,
  normalizeUsdPricing,
  resolveUsdPrice,
  usdContextTokens,
  usdTierOf,
} from '../src/pricing.mjs';
import { buildReport } from '../src/report-data.mjs';
import { renderHtml } from '../src/report-html.mjs';
import { averageTokenPrice } from '../src/money.mjs';

const CNY = normalizePricing({
  models: { 'claude-sonnet-5-5': { input: 2.3, output: 11.5, cacheWrite: 2.875, cacheRead: 0.23 } },
});
const USD = loadUsdPricing();
const LUNA = resolveUsdPrice('gpt-6-luna', USD);
const SOL = resolveUsdPrice('gpt-6.1-sol', USD);

const HAN = /\p{Script=Han}/u;

/** Visible text only: embedded JSON payload and runtime source are not chrome. */
function visibleText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    // The language switch link is part of the chrome, not translated copy.
    .replace(/<a class="lang-link"[\s\S]*?<\/a>/gi, ' ');
}

let seq = 0;
function event(type, data = {}, time = 1794000000000) {
  seq += 1;
  return { type, seq, time, data };
}
function usage(inputTokens, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0) {
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}
function codexSample(model, usageValue, step = 1) {
  return [event('model/selection', { provider: 'codex', model }), event('assistant/message', { turn: 1, step, usage: usageValue })];
}

test('the USD table lists the six mirror models, the legacy luna row and the threshold', () => {
  assert.equal(USD.currency, 'USD');
  assert.equal(USD.unitTokens, 1000000);
  assert.equal(USD.longContextThreshold, DEFAULT_USD_LONG_CONTEXT_THRESHOLD);
  assert.equal(USD.longContextThreshold, 272000);
  assert.equal(USD.source.retrievedAt, '2026-11-14');
  assert.match(USD.source.url, /aicodemirror\.ai\/pricing/u);
  assert.match(USD.source.api, /api\/model-pricing/u);
  assert.deepEqual(Object.keys(USD.models).sort(), [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-6-astra',
    'gpt-6-luna',
    'gpt-6-sol',
    'gpt-6.1-sol',
    'gpt-6.1-terra',
  ]);
  const expected = {
    'gpt-6.1-sol': [2, 10, 2.5, 0.1, 4, 15, 5, 0.2],
    'gpt-6-sol': [2, 10, 2.5, 0.2, 4, 15, 5, 0.4],
    'gpt-6.1-terra': [1, 5, 1.25, 0.05, 2, 7.5, 2.5, 0.1],
    'gpt-6-astra': [10, 50, 12.5, 1, 20, 75, 25, 2],
    'gpt-5.6-sol': [5, 30, 6.25, 0.5, 10, 45, 12.5, 1],
    'gpt-5.6-terra': [2, 12, 2.5, 0.2, 4, 18, 5, 0.4],
  };
  for (const [id, rates] of Object.entries(expected)) {
    const price = USD.models[id];
    assert.equal(price.source, 'mirror', id + ' is mirror-verified');
    assert.deepEqual(
      [price.input, price.output, price.cacheWrite, price.cacheRead],
      rates.slice(0, 4),
      id + ' standard rates',
    );
    assert.deepEqual(
      [price.long.input, price.long.output, price.long.cacheWrite, price.long.cacheRead],
      rates.slice(4),
      id + ' long rates',
    );
  }
  // gpt-6-luna has no row in the public source: it keeps the previous USD rates
  // as an explicitly legacy entry instead of being deleted or made free.
  assert.equal(LUNA.key, 'gpt-6-luna');
  assert.equal(LUNA.price.source, 'legacy');
  assert.equal(LUNA.price.long, undefined);
  assert.deepEqual([LUNA.price.input, LUNA.price.output, LUNA.price.cacheWrite, LUNA.price.cacheRead], [0.1, 0.5, 0.125, 0.01]);
});

test('a partial long-context record is rejected instead of silently mispricing', () => {
  assert.throws(
    () =>
      normalizeUsdPricing({
        providers: ['codex'],
        models: { 'gpt-x': { input: 1, output: 2, cacheWrite: 3, cacheRead: 4, long: { input: 1, output: 2, cacheWrite: 3 } } },
      }),
    /long\.cacheRead must be a non-negative finite number/u,
  );
  assert.throws(
    () =>
      normalizeUsdPricing({
        providers: ['codex'],
        models: { 'gpt-x': { input: 1, output: 2, cacheWrite: 3, cacheRead: 4, source: 'mirror-ish' } },
      }),
    /source must be "mirror" or "legacy"/u,
  );
  // A non-string provenance is never silently swallowed into "mirror".
  assert.throws(
    () =>
      normalizeUsdPricing({
        providers: ['codex'],
        models: { 'gpt-x': { input: 1, output: 2, cacheWrite: 3, cacheRead: 4, source: 123 } },
      }),
    /source must be "mirror" or "legacy"/u,
  );
  // An omitted provenance is an explicit legacy fallback, not "verified".
  const legacyDefault = normalizeUsdPricing({
    providers: ['codex'],
    models: { 'gpt-x': { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 } },
  });
  assert.equal(legacyDefault.models['gpt-x'].source, 'legacy');
});

test('USD context is the three prompt buckets of one sample, never output', () => {
  assert.equal(usdContextTokens({ uncachedInputTokens: 1, outputTokens: 9_000_000, cacheWriteTokens: 2, cacheReadTokens: 3 }), 6);
  assert.equal(usdContextTokens({}), 0);
});

test('the long tier starts above the threshold and counts cache read and cache write', () => {
  const buckets = (prompt, output = 0, split = {}) => ({
    uncachedInputTokens: prompt,
    outputTokens: output,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    ...split,
  });
  const price = SOL.price;
  assert.equal(usdTierOf(buckets(272000), price), 'standard');
  assert.equal(usdTierOf(buckets(272001), price), 'long');
  // A huge output never triggers the long tier.
  assert.equal(usdTierOf(buckets(1, 10_000_000), price), 'standard');
  // Cached prompt tokens are part of the request context.
  assert.equal(usdTierOf(buckets(172000, 0, { cacheReadTokens: 100000 }), price), 'standard');
  assert.equal(usdTierOf(buckets(172000, 0, { cacheWriteTokens: 1, cacheReadTokens: 100000 }), price), 'long');
  // Exactly at the boundary is still the standard rate.
  assert.equal(costMicroUsd(buckets(272000), price), 272000 * 2);
  assert.equal(costMicroUsd(buckets(272001), price), 272001 * 4);
});

test('the long tier prices all four buckets at the long rates', () => {
  const buckets = { uncachedInputTokens: 100000, outputTokens: 1000, cacheWriteTokens: 100000, cacheReadTokens: 72001 };
  // prompt = 272001 > 272000, so every bucket uses the long rates
  assert.equal(costMicroUsd(buckets, SOL.price), Math.round(100000 * 4 + 1000 * 15 + 100000 * 5 + 72001 * 0.2));
});

test('the engine selects the USD tier from each sample own prompt size', () => {
  seq = 0;
  const events = [
    ...codexSample('gpt-6.1-sol', usage(272000), 1),
    ...codexSample('gpt-6.1-sol', usage(272001), 2),
  ];
  const result = analyzeEvents(events, CNY, USD);
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records.map((record) => record.usdTier), ['standard', 'long']);
  assert.deepEqual(result.records.map((record) => record.costMicroUsd), [544000, 1088004]);
  assert.equal(result.totals.costMicroCny, 0, 'USD rows never touch CNY');
  assert.equal(result.byModel.length, 1, 'both tiers stay one model row');
  assert.equal(result.byModel[0].priceKey, 'usd-gpt-6.1-sol');
  assert.equal(result.byModel[0].costMicroUsd, 544000 + 1088004);
});

test('a model listed in both tables is billed only in USD, with no CNY tier', () => {
  const both = normalizePricing({
    models: {
      'gpt-6.1-sol': {
        input: 1,
        output: 2,
        cacheWrite: 3,
        cacheRead: 4,
        peak: { input: 9, output: 9, cacheWrite: 9, cacheRead: 9 },
        peakHours: { timeZone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5], windows: ['09:00-12:00'], holidays: [] },
      },
    },
  });
  // 2026-10-26 02:00Z is Monday 10:00 in Asia/Shanghai: the CNY peak window.
  const peakTime = Date.parse('2026-10-26T02:00:00Z');
  const events = [
    { type: 'model/selection', seq: 1, time: peakTime, data: { provider: 'codex', model: 'gpt-6.1-sol' } },
    { type: 'assistant/message', seq: 2, time: peakTime, data: { turn: 1, step: 1, usage: usage(1000, 100) } },
  ];
  const result = analyzeEvents(events, both, USD);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].costMicroCny, 0, 'USD hit never falls through to CNY');
  assert.equal(result.records[0].tier, null, 'no CNY peak/off tier for a USD row');
  assert.equal(result.totals.costMicroCny, 0);
  assert.equal(result.totals.costMicroUsd, 1000 * 2 + 100 * 10);
});

test('a streamed sample replaced by a long-context final sample is billed once at the long rate', () => {
  seq = 0;
  const events = [
    ...codexSample('gpt-6.1-sol', usage(1000), 1),
    ...codexSample('gpt-6.1-sol', usage(272001), 1),
  ];
  const result = analyzeEvents(events, CNY, USD);
  assert.equal(result.records.length, 1, 'the final sample replaces the streaming one');
  assert.equal(result.records[0].costMicroUsd, 272001 * 4);
  assert.equal(result.totals.tokens.uncachedInputTokens, 272001);
  assert.equal(result.totals.costMicroUsd, 272001 * 4);
});

test('USD retries are separate samples and a model switch makes a second row', () => {
  seq = 0;
  const events = [
    ...codexSample('gpt-6.1-sol', usage(1000), 1),
    event('llm/retry-started', { turn: 1, step: 1 }),
    ...codexSample('gpt-6.1-sol', usage(2000), 1),
    ...codexSample('gpt-6-luna', usage(1000), 2),
  ];
  const result = analyzeEvents(events, CNY, USD);
  assert.equal(result.records.length, 3, 'retry is billed separately, then the switch adds a sample');
  assert.equal(result.byModel.length, 2);
  const sol = result.byModel.find((row) => row.model === 'gpt-6.1-sol');
  const luna = result.byModel.find((row) => row.model === 'gpt-6-luna');
  assert.equal(sol.costMicroUsd, 1000 * 2 + 2000 * 2);
  assert.equal(luna.costMicroUsd, 1000 * 0.1);
  assert.equal(result.totals.costMicroCny, 0);
});

test('the USD mean blends standard and long samples over their actual tokens', () => {
  seq = 0;
  const events = [
    ...codexSample('gpt-6.1-sol', usage(272000), 1),
    ...codexSample('gpt-6.1-sol', usage(272001), 2),
  ];
  const result = analyzeEvents(events, CNY, USD);
  const row = result.byModel[0];
  const expectedCost = 272000 * 2 + 272001 * 4;
  assert.equal(row.costMicroUsd, expectedCost);
  const average = averageTokenPrice([row]);
  assert.equal(average.usdTokens, 544001);
  assert.equal(average.usdMicroPerM, Math.round((expectedCost * 1e6) / 544001));
});

test('cache savings use the long input and cache-read rates at the long tier', () => {
  seq = 0;
  const events = codexSample('gpt-6.1-sol', usage(0, 0, 272001));
  const result = analyzeEvents(events, CNY, USD);
  assert.equal(result.records[0].usdTier, 'long');
  assert.equal(result.byModel[0].cacheSavingMicroUsd, Math.round(272001 * (4 - 0.2)));
});

test('gpt-6-luna keeps its legacy USD price and is not treated as free', () => {
  seq = 0;
  const events = codexSample('gpt-6-luna', usage(1_000_000, 1_000_000));
  const result = analyzeEvents(events, CNY, USD);
  const row = result.byModel[0];
  assert.equal(row.priceKey, 'usd-gpt-6-luna');
  assert.equal(row.priced, true);
  assert.equal(row.costMicroUsd, 600000);
  assert.deepEqual(result.unpricedModels, []);
  const average = averageTokenPrice([{ ...row, tokens: row.tokens }]);
  assert.equal(average.usdTokens, 2_000_000);
  assert.equal(average.usdMicroPerM, 300000);
});

test('unknown codex models stay unpriced and excluded from the USD average', () => {
  seq = 0;
  const events = codexSample('gpt-9-unlisted', usage(1000000, 0));
  const result = analyzeEvents(events, CNY, USD);
  assert.equal(result.byModel[0].priced, false);
  assert.equal(result.byModel[0].costMicroUsd, 0);
  assert.deepEqual(result.unpricedModels, ['gpt-9-unlisted']);
  const average = averageTokenPrice([result.byModel[0]]);
  assert.equal(average.usdTokens, 0);
  assert.equal(average.usdMicroPerM, 0);
});

function reportFor(events) {
  return buildReport({
    home: 'synthetic',
    sources: [{ label: 'synthetic', home: 'synthetic' }],
    pricing: CNY,
    usdPricing: USD,
    results: [
      {
        meta: { id: 's1', title: 'usd demo', createdAt: 1794000000000, source: 'synthetic' },
        analysis: analyzeEvents(events, CNY, USD),
      },
    ],
    generatedAt: 1794003600000,
  });
}

test('buildReport keeps the USD table as separate metadata and stays legacy-compatible', () => {
  const report = reportFor(codexSample('gpt-6.1-sol', usage(272001, 10)));
  assert.equal(report.currency, 'CNY');
  assert.equal(report.pricing.models['gpt-6.1-sol'], undefined, 'USD models never enter the CNY table');
  assert.equal(report.usdPricing.currency, 'USD');
  assert.equal(report.usdPricing.longContextThreshold, 272000);
  assert.deepEqual(report.usdPricing.canonicalProviders, ['codex']);
  assert.deepEqual(report.usdPricing.providers, ['codex', 'openai', 'host-codex']);
  assert.equal(report.usdPricing.models['gpt-6.1-sol'].long.output, 15);
  assert.equal(report.usdPricing.models['gpt-6.1-sol'].source, 'mirror');
  assert.equal(report.usdPricing.models['gpt-6-luna'].source, 'legacy');
  assert.equal(report.usdPricing.source.retrievedAt, '2026-11-14');
  // The report must hold a deep copy: mutating it cannot change the loaded table.
  report.usdPricing.models['gpt-6.1-sol'].long.output = 999;
  report.usdPricing.models['gpt-6.1-sol'].source = 'tampered';
  assert.equal(USD.models['gpt-6.1-sol'].long.output, 15);
  assert.equal(USD.models['gpt-6.1-sol'].source, 'mirror');
  assert.equal(report.summary.costMicroUsd, 272001 * 4 + 10 * 15);

  const legacy = buildReport({
    home: 'synthetic',
    sources: [],
    pricing: CNY,
    results: [],
    generatedAt: 1794003600000,
  });
  assert.equal(legacy.usdPricing, null);
});

test('the page shows a separate USD table with per-model provenance', () => {
  const report = reportFor(codexSample('gpt-6.1-sol', usage(272001, 10)));
  const zh = renderHtml(report);
  assert.match(zh, /美元价格表/u);
  assert.match(zh, /gpt-6\.1-sol/u);
  assert.match(zh, /\$4/u);
  assert.match(zh, /长档/u);
  assert.match(zh, /公开页核实/u);
  assert.match(zh, /沿用旧价（未核实）/u);
  assert.match(zh, /2026-11-14/u);
  assert.match(zh, /未缓存输入 \+ 缓存写 \+ 缓存读/u);
  const en = renderHtml(report, { locale: 'en' });
  assert.match(en, /USD price table/u);
  assert.match(en, /mirror-verified/u);
  assert.match(en, /legacy \(not re-verified\)/u);
  assert.doesNotMatch(visibleText(en), HAN, 'the English USD table must not leak Chinese');

  const legacy = buildReport({ home: 'synthetic', sources: [], pricing: CNY, results: [], generatedAt: 1794003600000 });
  // `visibleText` strips the embedded message table, which legitimately
  // carries the (unused) key text even when no USD table is rendered.
  assert.doesNotMatch(visibleText(renderHtml(legacy)), /美元价格表/u);
  assert.doesNotMatch(visibleText(renderHtml(legacy, { locale: 'en' })), /USD price table/u);
});

test('an unlisted codex model follows the normal unpriced path in every surface', () => {
  const report = reportFor(codexSample('gpt-9-unlisted', usage(1000, 100)));
  const zh = renderHtml(report);
  assert.match(zh, /未定价/u);
  assert.match(zh, /gpt-9-unlisted/u, 'the model stays visible with its tokens');
  assert.match(renderHtml(report, { locale: 'en' }), /unpriced/u);
  assert.equal(report.summary.costMicroUsd, 0);
  assert.deepEqual(report.summary.unpricedModels, ['gpt-9-unlisted']);
});

test('the terminal models report prints the CNY and USD tables', () => {
  const text = renderModels(CNY, USD);
  assert.match(text, /价格表（CNY/u);
  assert.match(text, /USD 价格表/u);
  assert.match(text, /gpt-6\.1-terra/u);
  assert.match(text, /gpt-6-luna/u);
  assert.match(text, /272,000/u);
  assert.match(text, /沿用旧价/u);
  assert.match(text, /适用提供方：codex/u);
  assert.match(text, /未缓存输入 \+ 缓存写 \+ 缓存读/u);
  assert.match(text, /不是免费/u);
});
