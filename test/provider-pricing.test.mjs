/**
 * Provider-scoped price cards: the AICodeMirror transcription, tier selection,
 * provider isolation, single-currency billing, and the price-page surface.
 *
 * The rates below are typed a second time from the same screenshot the card was
 * built from, so a typo in config/aicodemirror-pricing.json shows up as a test
 * failure instead of a silently wrong bill.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { analyzeEvents } from '../src/engine.mjs';
import { loadPricing, loadUsdPricing, normalizePricing, resolvePrice } from '../src/pricing.mjs';
import {
  billableRates,
  cnyFromUsd,
  findProviderModel,
  loadProviderPricing,
  normalizeProviderPricing,
  priceProviderSample,
  selectTier,
  summarizeProviderPricing,
} from '../src/provider-pricing.mjs';
import { renderHtml } from '../src/report-html.mjs';
import { buildReport, buildTimeRangeDataset } from '../src/report-data.mjs';
import { aggregateRangeStats } from '../src/time-range.mjs';
import { collectLiveReport, renderLiveFragment, writeLiveSnapshot } from '../src/live.mjs';
import { startLiveServer } from '../src/live-server.mjs';
import { providerPageEntries, providerPageFileName, providerPageHref, renderPriceLinks, renderProviderPage, tierOverlap } from '../src/pricing-pages.mjs';
import { main } from '../src/cli.mjs';

/** group id, model id, standard [in,out,cacheW,cacheR], long row or null, long threshold override. */
const TRANSCRIBED = [
  ['claudecode', 'claude-fable-5-2', [8, 40, 10, 0.2], null],
  ['claudecode', 'claude-fable-5-1', [10, 50, 12.5, 0.25], null],
  ['claudecode', 'claude-opus-5-5', [4, 20, 5, 0.2], null],
  ['claudecode', 'claude-sonnet-5-5', [2, 10, 2.5, 0.1], null],
  ['claudecode', 'claude-haiku-5-5', [0.1, 0.5, 0.125, 0.01], [0.5, 2.5, 0.625, 0.05], 100000, 100000],
  ['claudecode', 'claude-fable-5', [10, 50, 12.5, 1], null],
  ['claudecode', 'claude-opus-5', [5, 25, 6.25, 0.5], null],
  ['claudecode', 'claude-sonnet-5', [2, 10, 2.5, 0.2], null],
  ['claudecode', 'claude-opus-4-8', [5, 25, 6.25, 0.5], null],
  ['claudecode', 'claude-opus-4-7', [5, 25, 6.25, 0.5], null],
  ['claudecode', 'claude-opus-4-6', [5, 25, 6.25, 0.5], null],
  ['claudecode', 'claude-sonnet-4-6', [3, 15, 3.75, 0.3], null],
  ['claudecode', 'claude-haiku-4-5-20251001', [1, 5, 1.25, 0.1], null],
  ['codex', 'gpt-6.2-astra', [8, 40, 10, 0.4], [16, 60, 20, 0.8]],
  ['codex', 'gpt-6.2-sol', [2, 10, 2.5, 0.1], [4, 15, 5, 0.2]],
  ['codex', 'gpt-6-astra', [10, 50, 12.5, 1], [20, 75, 25, 2]],
  ['codex', 'gpt-6.1-sol', [2, 10, 2.5, 0.1], [4, 15, 5, 0.2]],
  ['codex', 'gpt-6.1-terra', [1, 5, 1.25, 0.05], [2, 7.5, 2.5, 0.1]],
  ['codex', 'gpt-6-sol', [2, 10, 2.5, 0.2], [4, 15, 5, 0.4]],
  ['codex', 'gpt-5.6-sol', [5, 30, 6.25, 0.5], [10, 45, 12.5, 1]],
  ['codex', 'gpt-5.6-terra', [2, 12, 2.5, 0.2], [4, 18, 5, 0.4]],
  ['gemini', 'gemini-4-hydrogen', [1.5, 7.5, null, 0.075], null],
  ['gemini', 'gemini-4-carbon', [2, 10, null, 0.1], null],
  ['gemini', 'gemini-4-argon', [2, 10, null, 0.1], null],
  ['gemini', 'gemini-3.8-flash', [0.75, 3.75, null, 0.075], null],
  ['gemini', 'gemini-3-flash-preview', [0.5, 3, null, 0.05], null],
  ['grok', 'grok-4.7', [2, 6, null, 0.5], [4, 12, null, 1]],
  ['grok', 'grok-4.6', [2, 6, null, 0.5], [4, 12, null, 1]],
  ['grok', 'grok-4.5', [2, 6, null, 0.3], [4, 12, null, 0.6]],
  ['grok', 'grok-build-0.1', [1, 2, null, 0.2], [2, 4, null, 0.4]],
];

const GROUPS = {
  claudecode: { factor: 1.15, std: 272000, long: null },
  codex: { factor: 0.5, std: 272000, long: 272000 },
  gemini: { factor: 0.94, std: null, long: null },
  grok: { factor: 0.43, std: 200000, long: 200000 },
};

const card = loadProviderPricing();

/** Four-rate tuple of one tier (cacheWrite null stays null). */
function tuple(tier) {
  return [tier.usd.input, tier.usd.output, tier.usd.cacheWrite, tier.usd.cacheRead];
}

/** Engine sample for one route/model/usage pair. */
function analyzeOne(provider, model, usage) {
  return analyzeEvents(
    [
      { type: 'model/selection', seq: 0, time: 1792830000000, data: { provider, model } },
      { type: 'assistant/message', seq: 1, time: 1792830000001, data: { turn: 1, step: 1, usage } },
    ],
    loadPricing(),
    loadUsdPricing(),
    card,
  );
}

/** A demo DSH home with one AICodeMirror Claude request. */
function demoHome() {
  const home = mkdtempSync(join(tmpdir(), 'costlive-provider-'));
  const dir = join(home, 'sessions', '--F-demo--', 'session-provider-0001');
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'session', version: 4, id: 'session-provider-0001', createdAt: 1792830000000, cwd: '/demo', agentPreset: 'standard' },
    { type: 'model/selection', seq: 0, time: 1792830000001, data: { provider: 'aicodemirror1', model: 'claude-sonnet-5-5' } },
    {
      type: 'assistant/message',
      seq: 1,
      time: 1792830000002,
      data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 200 } },
    },
    { type: 'session/title', seq: 2, time: 1792830000003, data: { title: 'provider pricing demo' } },
  ];
  const frames = lines.map((line) => zstdCompressSync(Buffer.from(JSON.stringify(line) + '\n')));
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames));
  return home;
}

test('the card publishes 4 groups, 30 models and 43 tiers (13 long)', () => {
  const summary = summarizeProviderPricing(card);
  assert.equal(summary.provider, 'aicodemirror1');
  assert.equal(summary.groups, 4);
  assert.equal(summary.models, 30);
  assert.equal(summary.tiers, 43);
  assert.equal(summary.longTiers, 13);
  assert.deepEqual(summary.groupsById, { claudecode: 13, codex: 8, gemini: 5, grok: 4 });
  // The screenshot lists 30 models, not 34: 13 Claude + 8 Codex + 5 Gemini + 4 Grok.
  assert.equal(13 + 8 + 5 + 4, summary.models);
});

test('every transcribed USD row matches the shipped card', () => {
  let rows = 0;
  for (const [groupId, modelId, std, long, longOver, stdBound] of TRANSCRIBED) {
    const model = findProviderModel(card, modelId);
    assert.ok(model !== null, modelId);
    assert.equal(model.groupId, groupId, modelId);
    const standard = model.tiers.find((tier) => tier.id === 'standard');
    assert.ok(standard, modelId + ' standard');
    assert.deepEqual(tuple(standard), std, modelId + ' standard');
    const group = GROUPS[groupId];
    const expectedUpTo = stdBound === undefined ? group.std : stdBound;
    if (expectedUpTo === null) assert.equal(standard.upTo, null, modelId + ' standard bound');
    else assert.equal(standard.upTo, expectedUpTo, modelId + ' standard bound');
    const longTier = model.tiers.find((tier) => tier.id === 'long');
    if (long === null) {
      assert.equal(longTier, undefined, modelId + ' has no long tier');
    } else {
      assert.ok(longTier, modelId + ' long');
      assert.deepEqual(tuple(longTier), long, modelId + ' long');
      assert.equal(longTier.over, longOver ?? group.long, modelId + ' long threshold');
    }
    rows += model.tiers.length;
  }
  assert.equal(rows, 43);
  assert.equal(TRANSCRIBED.length, 30);
});

test('CNY is USD x the group factor, rounded to 6 decimals per bucket', () => {
  for (const group of card.groups) {
    for (const model of group.models) {
      for (const tier of model.tiers) {
        for (const field of ['input', 'output', 'cacheWrite', 'cacheRead']) {
          const usd = tier.usd[field];
          const cny = tier.cny[field];
          if (usd === null) {
            assert.equal(cny, null, group.id + '/' + model.id + ' ' + field);
            continue;
          }
          assert.equal(cny, cnyFromUsd(usd, group.factor), group.id + '/' + model.id + ' ' + field);
          assert.equal(Math.round(cny * 1e6), cny * 1e6, '6 decimals');
        }
      }
    }
  }
  assert.deepEqual(card.groups.map((group) => group.factor), [1.15, 0.5, 0.94, 0.43]);
  const sonnet = findProviderModel(card, 'claude-sonnet-5-5').tiers[0];
  assert.deepEqual([sonnet.cny.input, sonnet.cny.output, sonnet.cny.cacheWrite, sonnet.cny.cacheRead], [2.3, 11.5, 2.875, 0.115]);
  const sol = findProviderModel(card, 'gpt-6.1-sol').tiers[0];
  assert.deepEqual([sol.cny.input, sol.cny.output, sol.cny.cacheWrite, sol.cny.cacheRead], [1, 5, 1.25, 0.05]);
  const flash = findProviderModel(card, 'gemini-3-flash-preview').tiers[0];
  assert.deepEqual([flash.cny.input, flash.cny.output, flash.cny.cacheRead], [0.47, 2.82, 0.047]);
  const grok = findProviderModel(card, 'grok-4.7').tiers[0];
  assert.deepEqual([grok.cny.input, grok.cny.output, grok.cny.cacheRead], [0.86, 2.58, 0.215]);
});

test('tiers split at 272K / 200K and only above the threshold', () => {
  const sample = (model, ctx) =>
    priceProviderSample({
      doc: card,
      provider: 'aicodemirror1',
      model,
      buckets: { uncachedInputTokens: ctx, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
    });
  assert.equal(sample('gpt-6.2-sol', 272000).tier.id, 'standard');
  assert.equal(sample('gpt-6.2-sol', 272001).tier.id, 'long');
  assert.equal(sample('claude-fable-5-2', 272000).tier.id, 'standard');
  assert.equal(sample('claude-fable-5-2', 272001).tier.id, 'standard', 'no published long tier');
  assert.equal(sample('claude-fable-5-2', 272001).contextOver, true);
  assert.equal(sample('claude-fable-5-2', 272001).estimated, true);
  assert.equal(sample('grok-4.7', 200000).tier.id, 'standard');
  assert.equal(sample('grok-4.7', 200001).tier.id, 'long');
  // The threshold is the request's prompt total, cache buckets included.
  assert.equal(
    priceProviderSample({ doc: card, provider: 'aicodemirror1', model: 'gpt-6.2-sol', buckets: { uncachedInputTokens: 72000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 200000 } }).tier.id,
    'standard',
  );
  assert.equal(
    priceProviderSample({ doc: card, provider: 'aicodemirror1', model: 'gpt-6.2-sol', buckets: { uncachedInputTokens: 72001, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 200000 } }).tier.id,
    'long',
  );
});

test('claude-haiku-5-5 splits at 100K, not at the stale 272K wording', () => {
  // The user confirmed 2026-11-25 that the provider's "<=272K" text is wrong and
  // this model's standard tier ends at 100K; the long tier starts above it.
  const model = findProviderModel(card, 'claude-haiku-5-5');
  assert.equal(tierOverlap(model), null);
  assert.equal(selectTier(model, 100000).status, 'price');
  assert.equal(selectTier(model, 100000).tier.id, 'standard');
  assert.equal(selectTier(model, 100001).status, 'price');
  assert.equal(selectTier(model, 100001).tier.id, 'long');
  assert.equal(selectTier(model, 272000).tier.id, 'long');
  // Prompt total includes the cache buckets, so 60K cached + 40K new is exactly
  // the 100K boundary, and one more token crosses it.
  const at = (uncached, cached) =>
    priceProviderSample({
      doc: card,
      provider: 'aicodemirror1',
      model: 'claude-haiku-5-5',
      buckets: { uncachedInputTokens: uncached, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: cached },
    });
  assert.equal(at(40000, 60000).tier.id, 'standard');
  assert.equal(at(40001, 60000).tier.id, 'long');
  const standard = analyzeOne('aicodemirror1', 'claude-haiku-5-5', { inputTokens: 100000, outputTokens: 0 });
  assert.equal(standard.totals.costMicroCny, 100000 * 0.115);
  assert.equal(standard.byModel[0].priceKey, 'acm-claudecode-standard');
  const long = analyzeOne('aicodemirror1', 'claude-haiku-5-5', { inputTokens: 100001, outputTokens: 0 });
  assert.equal(long.totals.costMicroCny, Math.round(100001 * 0.575));
  assert.equal(long.byModel[0].priceKey, 'acm-claudecode-long');
  // No ambiguous rows and no conflict note for the shipped card any more.
  const report = buildReport({ home: 'demo', sources: [{ label: 'host', home: 'demo' }], pricing: loadPricing(), results: [], generatedAt: 1792830000000 });
  const page = renderProviderPage({ id: 'aicodemirror1', report, card, usdPricing: loadUsdPricing(), pricing: loadPricing(), locale: 'zh' });
  assert.match(page, /claude-haiku-5-5/u);
  assert.doesNotMatch(page, /档位重叠/u);
  assert.doesNotMatch(page, /100K–272K/u);
  assert.match(page, /≤100K/u);
  assert.match(page, /&gt;100K/u);
  // The page names its source instead of presenting an anonymous number.
  assert.match(page, /AICodeMirror public price table/u);
  assert.match(page, /价目来源/u);
});

test('a genuinely overlapping card still stays unpriced (generic guard)', () => {
  const overlapping = normalizeProviderPricing({
    provider: 'aicodemirror1',
    groups: [
      {
        id: 'overlap',
        label: 'Overlap',
        factor: 1,
        models: [
          {
            id: 'overlap-model',
            standard: { upTo: 272000, input: 1, output: 1, cacheWrite: 1, cacheRead: 0.1 },
            long: { over: 100000, input: 2, output: 2, cacheWrite: 2, cacheRead: 0.2 },
          },
        ],
      },
    ],
  });
  assert.deepEqual(tierOverlap(findProviderModel(overlapping, 'overlap-model')), { over: 100000, upTo: 272000, lower: 'long', upper: 'standard' });
  const analysis = analyzeEvents(
    [
      { type: 'model/selection', seq: 0, time: 1792830000000, data: { provider: 'aicodemirror1', model: 'overlap-model' } },
      { type: 'assistant/message', seq: 1, time: 1792830000001, data: { turn: 1, step: 1, usage: { inputTokens: 150000, outputTokens: 10 } } },
    ],
    loadPricing(),
    loadUsdPricing(),
    overlapping,
  );
  assert.equal(analysis.totals.costMicroCny, 0);
  assert.deepEqual(analysis.unpricedModels, ['overlap-model']);
  assert.match(analysis.warnings.join('\n'), /ambiguous price for model "overlap-model"/u);
});

test('only the requesting provider is repriced; another route keeps its own table', () => {
  const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 200 };
  const acm = analyzeOne('aicodemirror1', 'claude-sonnet-5-5', usage);
  const legacy = analyzeOne('anthropic-direct', 'claude-sonnet-5-5', usage);
  assert.equal(acm.totals.costMicroCny, 4083);
  assert.equal(acm.byModel[0].priceKey, 'acm-claudecode-standard');
  assert.equal(legacy.totals.costMicroCny, 4140);
  assert.equal(legacy.byModel[0].priceKey, 'claude-sonnet-5-5');
  // The legacy CNY row keeps the cache-read rate it always had.
  assert.equal(loadPricing().models['claude-sonnet-5-5'].cacheRead, 0.23);
  // A model that only the card publishes is unpriced on any other route.
  const sol = analyzeOne('aicodemirror1', 'gpt-6.1-sol', { inputTokens: 1000, outputTokens: 1000 });
  assert.equal(sol.totals.costMicroCny, 1000 * 1 + 1000 * 5);
  const solElsewhere = analyzeOne('some-codex-reseller', 'gpt-6.1-sol', { inputTokens: 1000, outputTokens: 1000 });
  assert.equal(solElsewhere.totals.costMicroCny, 0);
  assert.deepEqual(solElsewhere.unpricedModels, ['gpt-6.1-sol']);
});

test('every bucket is billed at USD x factor in CNY and never duplicated in USD', () => {
  const million = 1000000;
  const analysis = analyzeOne('aicodemirror1', 'claude-sonnet-5-5', {
    inputTokens: million,
    outputTokens: million,
    cacheReadTokens: million,
    cacheWriteTokens: million,
  });
  // 1M x (2.3 + 11.5 + 2.875 + 0.115) = 16.79 CNY
  assert.equal(analysis.totals.costMicroCny, 16790000);
  assert.equal(analysis.totals.costCny, 16.79);
  assert.equal(analysis.totals.costMicroUsd, 0);
  assert.equal(analysis.totals.costUsd, 0);
  assert.equal(analysis.byModel[0].costMicroUsd, 0);
  // Cache saving is derived from the card's CNY rates, not the legacy row.
  assert.equal(analysis.byModel[0].cacheSavingMicroCny, Math.round(million * (2.3 - 0.115)));
  // Four groups apply four different factors to the same request. A small prompt
  // keeps every call inside the standard tier, so only the factor differs.
  const cost = (model) =>
    analyzeOne('aicodemirror1', model, { inputTokens: 1000, outputTokens: 0 }).totals.costMicroCny;
  assert.equal(cost('claude-sonnet-5-5'), 2300);
  assert.equal(cost('gpt-6.1-sol'), 1000);
  assert.equal(cost('gemini-4-carbon'), 1880);
  assert.equal(cost('grok-4.7'), 860);
  // The same 1M-token prompt crosses the Codex threshold and bills the long tier.
  assert.equal(analyzeOne('aicodemirror1', 'gpt-6.1-sol', { inputTokens: million, outputTokens: 0 }).totals.costMicroCny, 2000000);
});

test('an unpublished cache-write rate falls back to input and is flagged, never free', () => {
  const analysis = analyzeOne('aicodemirror1', 'gemini-3-flash-preview', { inputTokens: 1000, outputTokens: 1000, cacheWriteTokens: 1000 });
  const row = analysis.byModel[0];
  assert.equal(row.estimated, true);
  assert.equal(row.estimatedReason, 'cache-write-missing');
  assert.equal(analysis.totals.estimatedSamples, 1);
  // 1000 x 0.47 + 1000 x 2.82 + 1000 x 0.47 (fallback) = 3760 micro-CNY.
  assert.equal(analysis.totals.costMicroCny, 3760);
  assert.equal(analysis.totals.costUsd, 0);
  const page = renderProviderPage({ id: 'aicodemirror1', report: null, card, usdPricing: null, pricing: null, locale: 'zh' });
  assert.match(page, /price.missing.note|缓存创建列未公布/u);
  assert.match(page, /gemini-3-flash-preview/u);
  // The cache-write cell is a dash, not an invented rate.
  const rowHtml = /<tr class="[^"]*">\s*<td class="mono">gemini-3-flash-preview<\/td>[\s\S]*?<\/tr>/u.exec(page);
  assert.ok(rowHtml, 'gemini row');
  assert.equal((rowHtml[0].match(/—/gu) ?? []).length, 1);
});

test('without cache-write tokens the gemini row is exact, not an estimate', () => {
  const analysis = analyzeOne('aicodemirror1', 'gemini-3-flash-preview', { inputTokens: 1000, outputTokens: 0 });
  assert.equal(analysis.byModel[0].estimated, false);
  assert.equal(analysis.totals.estimatedSamples, 0);
  assert.equal(analysis.totals.costMicroCny, 470);
});

test('DeepSeek keeps its local table and its official route untouched', () => {
  const pricing = loadPricing();
  const deepseek = pricing.models['deepseek-v4.1-flash'];
  assert.deepEqual([deepseek.input, deepseek.output, deepseek.cacheWrite, deepseek.cacheRead], [0.15, 0.6, 0.15, 0.003]);
  // A direct DeepSeek request is still billed by the local CNY table.
  const direct = analyzeOne('deepseek', 'deepseek-v4.1-flash', { inputTokens: 1000000, outputTokens: 1000000, cacheWriteTokens: 0, cacheReadTokens: 1000000 });
  assert.ok(direct.totals.costMicroCny > 0);
  assert.equal(direct.totals.costMicroUsd, 0);
  // The official console route stays pending, never card-priced.
  const official = analyzeOne('opencode-go', 'deepseek-v4.1-flash', { inputTokens: 1000, outputTokens: 100 });
  assert.equal(official.totals.costMicroCny, 0);
  assert.equal(official.totals.costMicroUsd, 0);
  assert.equal(official.byModel[0].priceKey, 'opencode-pending');
  // The card is scoped to one provider and has no DeepSeek row at all.
  assert.equal(findProviderModel(card, 'deepseek-v4.1-flash'), null);
});

test('Codex USD list prices and their subscription table are unchanged', () => {
  const usd = loadUsdPricing();
  assert.deepEqual([...usd.providers], ['codex', 'openai', 'host-codex']);
  assert.deepEqual(usd.models['gpt-6.2-sol'], { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 });
  const analysis = analyzeOne('codex', 'gpt-6.2-sol', { inputTokens: 1000000, outputTokens: 0 });
  assert.equal(analysis.totals.costMicroUsd, 2000000);
  assert.equal(analysis.totals.costMicroCny, 0);
  // The AICodeMirror long tier must not leak into the Codex reference table.
  assert.equal(usd.models['gpt-6.2-sol'].input, 2);
  assert.equal(findProviderModel(card, 'gpt-6.2-sol').tiers[1].usd.input, 4);
});

test('unlisted models and dated ids fall back exactly as before', () => {
  assert.equal(findProviderModel(card, 'gpt-9-unlisted'), null);
  assert.equal(findProviderModel(card, 'aicodemirror1/claude-sonnet-5-5'), findProviderModel(card, 'claude-sonnet-5-5'));
  assert.equal(findProviderModel(card, 'claude-sonnet-5-5-20260102'), findProviderModel(card, 'claude-sonnet-5-5'));
  assert.equal(findProviderModel(card, 'claude-haiku-4-5-20251001'), findProviderModel(card, 'claude-haiku-4-5-20251001'));
  // An undated id cannot guess which dated row the provider means: it stays unknown.
  assert.equal(findProviderModel(card, 'claude-haiku-4-5'), null);
  const unknown = analyzeOne('aicodemirror1', 'gpt-9-unlisted', { inputTokens: 1000, outputTokens: 100 });
  assert.equal(unknown.totals.costMicroCny, 0);
  assert.deepEqual(unknown.unpricedModels, ['gpt-9-unlisted']);
  assert.equal(unknown.byModel[0].estimated, false);
});

test('standard and long rows survive the browser recomputation unchanged', () => {
  const home = mkdtempSync(join(tmpdir(), 'costlive-provider-long-'));
  const dir = join(home, 'sessions', '--F-demo--', 'session-long-0001');
  try {
    mkdirSync(dir, { recursive: true });
    const lines = [
      { type: 'session', version: 4, id: 'session-long-0001', createdAt: 1792830000000, cwd: '/demo', agentPreset: 'standard' },
      { type: 'model/selection', seq: 0, time: 1792830000001, data: { provider: 'aicodemirror1', model: 'gpt-6.2-sol' } },
      { type: 'assistant/message', seq: 1, time: 1792830000002, data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 0 } } },
      { type: 'assistant/message', seq: 2, time: 1792830000003, data: { turn: 2, step: 1, usage: { inputTokens: 300000, outputTokens: 0 } } },
    ];
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(JSON.stringify(line) + '\n')))));
    const report = collectLiveReport({ home, billingDocument: { mode: 'usage' }, official: false });
    const rows = report.sessions[0].models;
    assert.deepEqual(rows.map((row) => row.contextTier).sort(), ['long', 'standard']);
    // 1000 tokens at 1 CNY/1M + 300000 tokens at 2 CNY/1M = 1000 + 600000 micro-CNY
    assert.equal(report.summary.costMicroCny, 601000);
    const dataset = buildTimeRangeDataset({ sessions: report.sessions, daily: report.daily, pricing: normalizePricing(loadPricing()) });
    const aggregated = aggregateRangeStats(dataset.sessions);
    assert.equal(aggregated.models.length, 2);
    assert.deepEqual(aggregated.models.map((row) => row.contextTier).sort(), ['long', 'standard']);
    const html = renderHtml(report);
    assert.match(html, /gpt-6\.2-sol（长档）/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the dashboard price section is one link per provider, with no inline table', () => {
  const home = demoHome();
  try {
    const report = collectLiveReport({ home, billingDocument: { mode: 'usage' }, official: false });
    const html = renderHtml(report);
    assert.match(html, /id="price-links"/u);
    assert.equal((html.match(/<a class="provider-link"/gu) ?? []).length, 4);
    for (const id of ['aicodemirror1', 'codex', 'opencode', 'deepseek']) {
      assert.match(html, new RegExp('data-provider="' + id + '" href="/pricing/' + id + '" target="_blank" rel="noopener noreferrer"', 'u'));
    }
    // DeepSeek's old unit rates are gone from the dashboard body.
    assert.doesNotMatch(html, /deepseek-v4\.1-flash<\/td>/u);
    assert.doesNotMatch(html, /0\.003/u);
    assert.doesNotMatch(html, /0\.15<\/td>/u);
    // No session id or title rides along in a price link.
    for (const href of html.match(/href="\/pricing\/[^"]*"/gu) ?? []) {
      assert.doesNotMatch(href, /session|title|cwd|home=|\?/u);
    }
    // The fragment swap carries the same links, so a refresh cannot break them.
    const fragment = renderLiveFragment(report);
    assert.equal((fragment.html.match(/<a class="provider-link"/gu) ?? []).length, 4);
    assert.match(fragment.html, /href="\/pricing\/aicodemirror1"/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a live fragment refresh keeps the links and the dataset consistent', async () => {
  const home = demoHome();
  const logger = { log() {}, warn() {} };
  let live = null;
  try {
    live = await startLiveServer({ host: '127.0.0.1', port: 0, reportOptions: { home, billingDocument: { mode: 'usage' }, official: false }, open: false, logger });
    const first = await (await fetch(live.url)).text();
    assert.equal((first.match(/<a class="provider-link"/gu) ?? []).length, 4);
    const fragment = await (await fetch(live.url + 'api/fragment')).json();
    assert.equal((fragment.html.match(/<a class="provider-link"/gu) ?? []).length, 4);
    const second = await (await fetch(live.url)).text();
    assert.equal((second.match(/<a class="provider-link"/gu) ?? []).length, 4);
    const report = await (await fetch(live.url + 'api/report')).json();
    const acm = report.providerUsage.find((row) => row.provider === 'aicodemirror1');
    assert.ok(acm);
    assert.equal(acm.costMicroUsd, 0);
    assert.equal(acm.models[0].contextTier, 'standard');
  } finally {
    if (live) await live.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the live server serves one same-origin price page per provider', async () => {
  const home = demoHome();
  const logger = { log() {}, warn() {} };
  let live = null;
  try {
    live = await startLiveServer({ host: '127.0.0.1', port: 0, reportOptions: { home, billingDocument: { mode: 'usage' }, official: false }, open: false, logger });
    const acm = await fetch(live.url + 'pricing/aicodemirror1');
    assert.equal(acm.status, 200);
    const page = await acm.text();
    assert.match(page, /ClaudeCode/u);
    assert.match(page, /Codex/u);
    assert.match(page, /Gemini/u);
    assert.match(page, /Grok/u);
    assert.equal((page.match(/data-group=/gu) ?? []).length, 4);
    assert.match(page, /¥2\.3/u);
    assert.match(page, /x1\.15/u);
    // Aggregated usage only: no session title, id or workspace.
    assert.doesNotMatch(page, /provider pricing demo/u);
    assert.doesNotMatch(page, /session-provider-0001/u);
    assert.doesNotMatch(page, /\/demo</u);

    const deepseek = await (await fetch(live.url + 'pricing/deepseek')).text();
    assert.doesNotMatch(deepseek, /0\.003/u);
    assert.doesNotMatch(deepseek, /deepseek-v4\.1-flash<\/td>/u);
    assert.match(deepseek, /本地计价|price.page.localTitle/u);

    assert.equal((await fetch(live.url + 'pricing/nope')).status, 404);
    const redirect = await fetch(live.url + 'pricing', { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    const head = await fetch(live.url + 'pricing/codex', { method: 'HEAD' });
    assert.equal(head.status, 200);

    const english = await (await fetch(live.url + 'pricing/aicodemirror1?lang=en')).text();
    const visible = english.replace(/<script[\s\S]*?<\/script>/gu, ' ').replace(/<style[\s\S]*?<\/style>/gu, ' ');
    assert.doesNotMatch(visible, /\p{Script=Han}/u);
    assert.match(visible, /\$2\.3|USD/u);
  } finally {
    if (live) await live.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a static snapshot writes relative companion pages', () => {
  const home = demoHome();
  const outDir = mkdtempSync(join(tmpdir(), 'costlive-provider-out-'));
  try {
    const report = collectLiveReport({ home, billingDocument: { mode: 'usage' }, official: false });
    const outPath = join(outDir, 'dsh-cost-live.html');
    writeLiveSnapshot({ outPath, report, mode: 'file', intervalMs: 20000, autoReload: false });
    const names = readdirSync(outDir).sort();
    assert.deepEqual(names, ['dsh-cost-live.html', 'pricing-aicodemirror1.html', 'pricing-codex.html', 'pricing-deepseek.html', 'pricing-opencode.html']);
    const mainHtml = readFileSync(outPath, 'utf8');
    assert.match(mainHtml, /href="pricing-aicodemirror1\.html"/u);
    assert.doesNotMatch(mainHtml, /href="\/pricing\//u);
    const acm = readFileSync(join(outDir, providerPageFileName('aicodemirror1')), 'utf8');
    assert.match(acm, /href="dsh-cost-live\.html"/u);
    assert.match(acm, /¥2\.3/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('the CLI report prices the provider card, not the legacy table', () => {
  const home = demoHome();
  const outDir = mkdtempSync(join(tmpdir(), 'costlive-provider-cli-json-'));
  try {
    const out = join(outDir, 'report.json');
    assert.equal(main(['report', '--home', home, '--format', 'json', '--out', out, '--no-official', '--billing-mode', 'usage']), 0);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    // 4083 comes from the card (cache read 0.115), while the legacy row would say 4140.
    assert.equal(report.summary.costMicroCny, 4083);
    assert.equal(report.summary.costUsd, 0);
    assert.equal(report.sessions[0].models[0].priceKey, 'acm-claudecode-standard');
    assert.equal(report.sessions[0].models[0].estimated, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('the CLI html report writes its companion price pages too', () => {
  const home = demoHome();
  const outDir = mkdtempSync(join(tmpdir(), 'costlive-provider-cli-'));
  try {
    const outPath = join(outDir, 'report.html');
    assert.equal(main(['report', '--home', home, '--format', 'html', '--out', outPath, '--no-official']), 0);
    const names = readdirSync(outDir).sort();
    assert.ok(names.includes('report.html'));
    assert.ok(names.includes('pricing-aicodemirror1.html'));
    const html = readFileSync(outPath, 'utf8');
    assert.match(html, /href="pricing-aicodemirror1\.html"/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('provider ids and model ids are escaped on the page', () => {
  const hostile = normalizeCard({
    provider: 'evil<&"provider',
    groups: [{ id: 'g1', label: 'Grp<&"', factor: 2, models: [{ id: 'model<img src=x onerror=alert(1)>', standard: { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 } }] }],
  });
  const page = renderProviderPage({ id: 'evil<&"provider', report: null, card: hostile, usdPricing: null, pricing: null, locale: 'zh' });
  assert.doesNotMatch(page, /<img src=x/u);
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.doesNotMatch(page, /<script/u);
  assert.equal(providerPageHref('a b&c'), '/pricing/a%20b%26c');
  const links = renderPriceLinks({
    report: { providerUsage: [], pricing: null },
    card: hostile,
    usdPricing: null,
    pricing: null,
    hrefFor: providerPageHref,
  });
  assert.match(links, /data-provider="evil&lt;&amp;&quot;provider"/u);
  // One hostile card link plus the always-present OpenCode link.
  assert.equal((links.match(/target="_blank" rel="noopener noreferrer"/gu) ?? []).length, 2);
});

test('provider entries keep a stable order and include observed routes', () => {
  const report = {
    providerUsage: [
      { provider: 'opencode', totalTokens: 10, costMicroCny: 0, costMicroUsd: 1, models: [] },
      { provider: 'custom-route', totalTokens: 5, costMicroCny: 0, costMicroUsd: 0, models: [] },
    ],
  };
  const entries = providerPageEntries({ report, card, usdPricing: loadUsdPricing(), pricing: loadPricing(), locale: 'zh' });
  assert.deepEqual(entries.map((entry) => entry.id), ['aicodemirror1', 'codex', 'opencode', 'deepseek', 'custom-route']);
  assert.equal(entries[0].counts, '4 组 · 30 个模型 · 43 档位');
  assert.equal(entries[0].usageText, '', 'no usage for AICodeMirror in this fixture');
  assert.match(entries[4].usageText, /本机用量/u);
});

/** Small helper so the escaping test can build a hostile card. */
function normalizeCard(raw) {
  return loadProviderPricingFromObject(raw);
}

/** Normalize an inline card document without touching disk. */
function loadProviderPricingFromObject(raw) {
  const groups = raw.groups.map((group) => ({
    id: group.id,
    label: group.label,
    factor: group.factor,
    models: group.models.map((model) => ({
      id: model.id,
      groupId: group.id,
      tiers: ['standard', 'long']
        .filter((id) => model[id] !== undefined)
        .map((id) => ({
          id,
          upTo: model[id].upTo ?? null,
          over: model[id].over ?? null,
          usd: {
            input: model[id].input,
            output: model[id].output,
            cacheWrite: model[id].cacheWrite ?? null,
            cacheRead: model[id].cacheRead,
          },
          cny: {
            input: cnyFromUsd(model[id].input, group.factor),
            output: cnyFromUsd(model[id].output, group.factor),
            cacheWrite: model[id].cacheWrite === null ? null : cnyFromUsd(model[id].cacheWrite, group.factor),
            cacheRead: cnyFromUsd(model[id].cacheRead, group.factor),
          },
        })),
    })),
  }));
  const index = new Map();
  for (const group of groups) for (const model of group.models) index.set(model.id.toLowerCase(), model);
  return { provider: raw.provider, quoteCurrency: 'USD', billingCurrency: 'CNY', unitTokens: 1000000, groups, index };
}
