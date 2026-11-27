import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { collectLiveReport, renderLiveDocument, writeLiveSnapshot } from '../src/live.mjs';
import { startLiveServer } from '../src/live-server.mjs';
import { loadPricing, loadUsdPricing, normalizePricing, priceAt } from '../src/pricing.mjs';
import { loadProviderPricing } from '../src/provider-pricing.mjs';
import {
  DEEPSEEK_PAGE_ID,
  DEEPSEEK_PRICING_SOURCE,
  canonicalPageId,
  providerPageEntries,
  providerPageFileName,
  providerPageHref,
  renderProviderPage,
} from '../src/pricing-pages.mjs';

/**
 * The DeepSeek price page.
 *
 * The dashboard links one page per provider, and DSH records the DeepSeek route
 * as `deepseek-account`. These tests pin three things:
 *
 *   1. exactly one DeepSeek link/page, with the legacy `deepseek` id only
 *      redirecting to it (query string kept);
 *   2. every number on the page comes from the effective CNY table — including
 *      peak/off-peak — so the page cannot drift from the bill or hardcode a
 *      tariff;
 *   3. the page states its source, bills cache write at the cache-miss rate and
 *      is honest about the local holidays list instead of promising automatic
 *      holiday detection.
 */

/** Wednesday 2026-10-28 13:00 +08:00 — the off-peak gap between peak windows. */
const OFF_AT = Date.parse('2026-10-28T05:00:00Z');
/** The same Wednesday 10:30 +08:00 — inside the morning peak window. */
const PEAK_AT = Date.parse('2026-10-28T02:30:00Z');

function writeSession(home, id, lines) {
  const dir = join(home, 'sessions', '--F-test--', id);
  mkdirSync(dir, { recursive: true });
  const frames = lines.map((line) => zstdCompressSync(Buffer.from(`${JSON.stringify(line)}\n`)));
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames));
}

/**
 * Two sessions that bill through the same DeepSeek service: one on the recorded
 * route (`deepseek-account`) and one on the retired route name (`deepseek`).
 * 1.5M uncached input at 1 CNY/1M = 1.5 CNY, both inside the off-peak window.
 */
function createHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cost-deepseek-page-'));
  writeSession(home, 'session-deepseek-0001', [
    { type: 'session', version: 4, id: 'session-deepseek-0001', createdAt: 1792830000000, cwd: 'F:\\test', agentPreset: 'standard' },
    { type: 'model/selection', seq: 0, time: OFF_AT, data: { provider: 'deepseek-account', model: 'deepseek-flash' } },
    { type: 'assistant/message', seq: 1, time: OFF_AT, data: { turn: 1, step: 1, usage: { inputTokens: 1000000, outputTokens: 0 } } },
    { type: 'session/title', seq: 2, time: OFF_AT, data: { title: 'DeepSeek 价目测试会话' } },
  ]);
  writeSession(home, 'session-deepseek-0002', [
    { type: 'session', version: 4, id: 'session-deepseek-0002', createdAt: 1792830001000, cwd: 'F:\\test' },
    { type: 'model/selection', seq: 0, time: OFF_AT, data: { provider: 'deepseek', model: 'deepseek-flash' } },
    { type: 'assistant/message', seq: 1, time: OFF_AT, data: { turn: 1, step: 1, usage: { inputTokens: 500000, outputTokens: 0 } } },
  ]);
  return home;
}

function reportOf(home) {
  return collectLiveReport({ home, billingDocument: { mode: 'usage' }, official: false });
}

test('one DeepSeek page: the recorded route, with the legacy id as an alias', () => {
  const pricing = loadPricing();
  const card = loadProviderPricing();
  const usd = loadUsdPricing();
  const report = {
    providerUsage: [
      { provider: 'deepseek-account', totalTokens: 10, costMicroCny: 1000, costMicroUsd: 0, models: [] },
      { provider: 'deepseek', totalTokens: 5, costMicroCny: 500, costMicroUsd: 0, models: [] },
    ],
  };
  const entries = providerPageEntries({ report, card, usdPricing: usd, pricing, locale: 'zh' });
  const deepseek = entries.filter((entry) => entry.id === 'deepseek' || entry.id === DEEPSEEK_PAGE_ID);
  assert.deepEqual(deepseek.map((entry) => entry.id), [DEEPSEEK_PAGE_ID]);
  assert.equal(deepseek[0].kind, 'local');
  // Both route names fold into the one page instead of producing a second link.
  assert.equal(entries.filter((entry) => entry.id === 'deepseek').length, 0);
  assert.equal(canonicalPageId('deepseek'), DEEPSEEK_PAGE_ID);
  assert.equal(canonicalPageId(DEEPSEEK_PAGE_ID), DEEPSEEK_PAGE_ID);
  assert.equal(canonicalPageId('opencode'), 'opencode');
  // A legacy link never prints the retired route either.
  assert.equal(providerPageHref('deepseek'), '/pricing/' + DEEPSEEK_PAGE_ID);
  assert.equal(providerPageHref(DEEPSEEK_PAGE_ID), '/pricing/' + DEEPSEEK_PAGE_ID);
  assert.equal(providerPageFileName('deepseek'), 'pricing-deepseek.html');
});

test('the page prints the effective CNY tariff: valley, peak, cache write, source', () => {
  const pricing = loadPricing();
  const price = pricing.models['deepseek-v4.1-flash'];
  assert.ok(price, 'shipped CNY entry');
  const page = renderProviderPage({ id: DEEPSEEK_PAGE_ID, report: null, card: loadProviderPricing(), usdPricing: loadUsdPricing(), pricing, locale: 'zh' });

  // Official served name plus the internal table id, never one without the other.
  assert.match(page, /deepseek-flash/u);
  assert.match(page, /deepseek-v4\.1-flash/u);
  // Both tiers are labelled, and each cell equals what billing applies.
  assert.match(page, /谷值/u);
  assert.match(page, /峰值/u);
  for (const tier of ['off', 'peak']) {
    const record = tier === 'off' ? priceAt(price, OFF_AT) : priceAt(price, PEAK_AT);
    const row = new RegExp('<tr data-tier="' + tier + '">[\\s\\S]*?</tr>', 'u').exec(page);
    assert.ok(row, tier + ' row');
    const cells = [...row[0].matchAll(/<td class="num">([^<]*)<\/td>/gu)].map((match) => match[1]);
    // input (cache miss), input (cache hit), output, cache write
    assert.deepEqual(cells, [String(record.input), String(record.cacheRead), String(record.output), String(record.cacheWrite)], tier);
  }
  // The official three buckets from the price page of 2026-11-27.
  assert.match(page, /<td class="num">1<\/td>/u);
  assert.match(page, /<td class="num">0\.02<\/td>/u);
  assert.match(page, /<td class="num">4<\/td>/u);
  assert.match(page, /<td class="num">2<\/td>/u);
  assert.match(page, /<td class="num">0\.04<\/td>/u);
  assert.match(page, /<td class="num">8<\/td>/u);
  // Cache write mirrors the miss rate and says so.
  assert.match(page, /缓存写入/u);
  assert.match(page, /未命中输入|miss/u);
  // The page names its source instead of presenting an anonymous number.
  assert.ok(page.includes(DEEPSEEK_PRICING_SOURCE));
  assert.match(page, /api-docs\.deepseek\.com\/zh-cn\/quick_start\/pricing\//u);
  // The old USD-scale numbers must not come back here.
  assert.doesNotMatch(page, /0\.003/u);
  assert.doesNotMatch(page, /\$0\.15/u);
});

test('the page follows the effective price document, not hardcoded constants', () => {
  // A deliberately different tariff: if the page carried its own numbers these
  // cells would still read 1 / 0.02 / 4 / 2 / 0.04 / 8.
  const pricing = normalizePricing({
    currency: 'CNY',
    unitTokens: 1000000,
    models: {
      'deepseek-v4.1-flash': {
        input: 3,
        output: 9,
        cacheWrite: 3,
        cacheRead: 0.03,
        peak: { input: 6, output: 18, cacheWrite: 6, cacheRead: 0.06 },
        peakHours: { holidays: ['2026-10-28'] },
      },
    },
    aliases: { 'deepseek-flash': 'deepseek-v4.1-flash' },
  });
  const page = renderProviderPage({ id: DEEPSEEK_PAGE_ID, report: null, card: null, usdPricing: null, pricing, locale: 'zh' });
  const off = /<tr data-tier="off">[\s\S]*?<\/tr>/u.exec(page)[0];
  const peak = /<tr data-tier="peak">[\s\S]*?<\/tr>/u.exec(page)[0];
  assert.deepEqual([...off.matchAll(/<td class="num">([^<]*)<\/td>/gu)].map((match) => match[1]), ['3', '0.03', '9', '3']);
  assert.deepEqual([...peak.matchAll(/<td class="num">([^<]*)<\/td>/gu)].map((match) => match[1]), ['6', '0.06', '18', '6']);
  // A configured holiday list is reported as such, with its dates.
  assert.match(page, /2026-10-28/u);
  assert.match(page, /holidays/u);
  assert.match(page, /1 天|1 day/u);
  assert.match(page, /未被|not detected|未列出/u);
});

test('peak hours and holidays are described from the effective config', () => {
  const pricing = loadPricing();
  const page = renderProviderPage({ id: DEEPSEEK_PAGE_ID, report: null, card: null, usdPricing: null, pricing, locale: 'zh' });
  // Real hours from the shipped window, not a vague "weekday peak".
  assert.match(page, /09:00-12:00/u);
  assert.match(page, /14:00-18:00/u);
  assert.match(page, /Asia\/Shanghai/u);
  assert.match(page, /周一至周五/u);
  // The shipped table lists no holidays; the page must say so instead of
  // claiming automatic holiday detection.
  assert.deepEqual(pricing.models['deepseek-v4.1-flash'].peakHours.holidays, []);
  assert.match(page, /holidays 为空/u);
  assert.match(page, /不会被自动识别/u);
});

test('the English page is fully translated and cites the same source', () => {
  const page = renderProviderPage({ id: DEEPSEEK_PAGE_ID, report: null, card: null, usdPricing: null, pricing: loadPricing(), locale: 'en' });
  const visible = page.replace(/<style[\s\S]*?<\/style>/gu, ' ').replace(/<script[\s\S]*?<\/script>/gu, ' ');
  assert.doesNotMatch(visible, /\p{Script=Han}/u);
  assert.match(page, /off-peak/u);
  assert.match(page, /peak/u);
  assert.match(page, /cache write/iu);
  assert.match(page, /cache-miss|miss/u);
  assert.match(page, /holidays are not detected automatically/u);
  assert.ok(page.includes(DEEPSEEK_PRICING_SOURCE));
  assert.match(page, /<td class="num">0\.04<\/td>/u);
});

test('without a DeepSeek entry there is no page and no link (never an empty tariff)', () => {
  const pricing = normalizePricing({ models: { 'claude-sonnet-5-5': { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 } } });
  assert.equal(renderProviderPage({ id: DEEPSEEK_PAGE_ID, report: null, card: null, usdPricing: null, pricing, locale: 'zh' }), null);
  const entries = providerPageEntries({ report: { providerUsage: [] }, card: null, usdPricing: null, pricing, locale: 'zh' });
  assert.equal(entries.some((entry) => entry.id === DEEPSEEK_PAGE_ID), false);
});

test('the dashboard keeps one DeepSeek link and no inline rates', () => {
  const home = createHome();
  try {
    const report = reportOf(home);
    assert.deepEqual(report.providerUsage.map((row) => row.provider).sort(), ['deepseek', 'deepseek-account']);
    const html = renderLiveDocument({ report, mode: 'http', intervalMs: 20000, locale: 'zh' });
    const links = [...html.matchAll(/<a class="provider-link"[^>]*>/gu)].map((match) => match[0]);
    const deepseek = links.filter((link) => /data-provider="deepseek(-account)?"/u.test(link));
    assert.equal(deepseek.length, 1);
    assert.match(deepseek[0], /data-provider="deepseek-account"/u);
    assert.match(deepseek[0], /href="\/pricing\/deepseek-account"/u);
    assert.doesNotMatch(html, /href="\/pricing\/deepseek"/u);
    // The dashboard itself still shows no DeepSeek unit price.
    assert.doesNotMatch(html, /0\.02/u);
    assert.doesNotMatch(html, /0\.003/u);
    // Both route names bill into the same page aggregate.
    assert.match(html, /1,500,000/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the live server serves the canonical page and redirects the old route', async () => {
  const home = createHome();
  const logger = { log() {}, warn() {} };
  let live = null;
  try {
    live = await startLiveServer({
      host: '127.0.0.1',
      port: 0,
      intervalMs: 20000,
      reportOptions: { home, billingDocument: { mode: 'usage' }, official: false },
      open: false,
      logger,
    });

    const pageResponse = await fetch(live.url + 'pricing/' + DEEPSEEK_PAGE_ID);
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.text();
    assert.match(page, /deepseek-flash/u);
    assert.match(page, /<td class="num">1<\/td>/u);
    assert.match(page, /<td class="num">0\.02<\/td>/u);
    assert.match(page, /<td class="num">4<\/td>/u);
    assert.match(page, /<td class="num">2<\/td>/u);
    assert.match(page, /<td class="num">0\.04<\/td>/u);
    assert.match(page, /<td class="num">8<\/td>/u);
    assert.ok(page.includes(DEEPSEEK_PRICING_SOURCE));
    assert.match(page, /1,500,000/u);
    // Aggregated usage only: no session title, id or workspace path.
    assert.doesNotMatch(page, /DeepSeek 价目测试会话/u);
    assert.doesNotMatch(page, /session-deepseek-0001/u);
    assert.doesNotMatch(page, /F:\\test/u);

    // A trailing slash resolves to the same page.
    assert.equal((await fetch(live.url + 'pricing/' + DEEPSEEK_PAGE_ID + '/')).status, 200);
    // HEAD works for the canonical route.
    assert.equal((await fetch(live.url + 'pricing/' + DEEPSEEK_PAGE_ID, { method: 'HEAD' })).status, 200);

    // The legacy route redirects, keeping the query string (so ?lang=en works).
    const legacy = await fetch(live.url + 'pricing/deepseek', { redirect: 'manual' });
    assert.equal(legacy.status, 302);
    assert.equal(legacy.headers.get('location'), '/pricing/' + DEEPSEEK_PAGE_ID);
    const legacyEnglish = await fetch(live.url + 'pricing/deepseek?lang=en', { redirect: 'manual' });
    assert.equal(legacyEnglish.status, 302);
    assert.equal(legacyEnglish.headers.get('location'), '/pricing/' + DEEPSEEK_PAGE_ID + '?lang=en');

    const english = await (await fetch(live.url + 'pricing/' + DEEPSEEK_PAGE_ID + '?lang=en')).text();
    const visible = english.replace(/<script[\s\S]*?<\/script>/gu, ' ').replace(/<style[\s\S]*?<\/style>/gu, ' ');
    assert.doesNotMatch(visible, /\p{Script=Han}/u);
    assert.match(visible, /off-peak/u);

    assert.equal((await fetch(live.url + 'pricing/nope')).status, 404);
  } finally {
    if (live) await live.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a static snapshot writes the canonical companion page plus a legacy stub', () => {
  const home = createHome();
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-cost-deepseek-page-out-'));
  try {
    const report = reportOf(home);
    const outPath = join(outDir, 'dsh-cost-live.html');
    writeLiveSnapshot({ outPath, report, mode: 'file', intervalMs: 20000, autoReload: false, locale: 'zh' });
    const names = readdirSync(outDir).sort();
    assert.ok(names.includes('pricing-deepseek-account.html'), names.join(','));
    assert.ok(names.includes('pricing-deepseek.html'), names.join(','));
    // The snapshot links the canonical file, never the forwarding stub.
    const main = readFileSync(outPath, 'utf8');
    assert.match(main, /href="pricing-deepseek-account\.html"/u);
    assert.doesNotMatch(main, /href="pricing-deepseek\.html"/u);
    const canonical = readFileSync(join(outDir, 'pricing-deepseek-account.html'), 'utf8');
    assert.match(canonical, /<td class="num">0\.02<\/td>/u);
    assert.match(canonical, /<td class="num">8<\/td>/u);
    assert.ok(canonical.includes(DEEPSEEK_PRICING_SOURCE));
    assert.match(canonical, /href="dsh-cost-live\.html"/u);
    const stub = readFileSync(join(outDir, 'pricing-deepseek.html'), 'utf8');
    assert.match(stub, /http-equiv="refresh" content="0; url=pricing-deepseek-account\.html"/u);
    assert.doesNotMatch(stub, /<td class="num">/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});
