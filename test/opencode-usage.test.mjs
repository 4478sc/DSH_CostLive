import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, buildTimeRangeDataset } from '../src/report-data.mjs';
import { renderHtml } from '../src/report-html.mjs';
import { renderLiveFragment } from '../src/live.mjs';
import { aggregateDayStats, aggregateRangeStats, formatDay, localMidnight } from '../src/time-range.mjs';
import {
  applyOfficialOverlay,
  describeSyncFailure,
  officialWindowTotals,
  groupBySession,
  mergeOfficialRecords,
  normalizeLogItem,
  officialAnalysis,
  recordTokens,
  sessionKey,
  summarizeStore,
} from '../src/opencode-usage.mjs';
import { checkAuth, nextSyncDelay } from '../tools/opencode-sync.mjs';

const raw = (over = {}) => ({
  id: 'req-1',
  startedAt: 1793400000000,
  sessionID: 'session-abc',
  provider: 'opencode',
  model: 'deepseek-v4.1-flash',
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 5000,
  cacheWriteTokens: 0,
  cost: 0.002,
  ...over,
});

test('sessionKey ignores the session- prefix on either side', () => {
  assert.equal(sessionKey('session-abc'), 'abc');
  assert.equal(sessionKey('abc'), 'abc');
  assert.equal(sessionKey(null), '');
});

test('normalizeLogItem coerces missing usage to zero and drops rows without id/time', () => {
  const record = normalizeLogItem(raw({ inputTokens: null, cost: -1, sessionID: '' }));
  assert.equal(record.tokens.uncachedInputTokens, 0);
  assert.equal(record.costUsd, 0);
  assert.equal(record.sessionID, null);
  assert.equal(record.model, 'deepseek-v4.1-flash');
  assert.equal(normalizeLogItem({ startedAt: 1 }), null);
  assert.equal(normalizeLogItem({ id: 'x', startedAt: 0 }), null);
});

test('mergeOfficialRecords dedupes by request id and keeps start order', () => {
  const a = normalizeLogItem(raw({ id: 'a', startedAt: 300 }));
  const b = normalizeLogItem(raw({ id: 'b', startedAt: 100 }));
  const bAgain = normalizeLogItem(raw({ id: 'b', startedAt: 100, outputTokens: 999 }));
  const { records, added } = mergeOfficialRecords([a], [b, bAgain]);
  assert.equal(added, 1);
  assert.deepEqual(records.map((r) => r.id), ['b', 'a']);
  assert.equal(mergeOfficialRecords(records, records).added, 0);
});

test('groupBySession normalizes ids and skips rows without a session', () => {
  const rows = [
    normalizeLogItem(raw({ id: '1', sessionID: 'session-abc' })),
    normalizeLogItem(raw({ id: '2', sessionID: 'abc' })),
    normalizeLogItem(raw({ id: '3', sessionID: null })),
  ];
  const grouped = groupBySession(rows);
  assert.equal(grouped.size, 1);
  assert.equal(grouped.get('abc').length, 2);
});

test('officialAnalysis mirrors the engine shape and keeps costs in USD', () => {
  const rows = [
    normalizeLogItem(raw({ id: '1', cost: 0.01, inputTokens: 10, outputTokens: 20, cacheReadTokens: 30 })),
    normalizeLogItem(raw({ id: '2', cost: 0.02, inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, model: 'other' })),
    normalizeLogItem(raw({ id: '3', cost: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 })),
  ];
  const analysis = officialAnalysis(rows);
  assert.equal(analysis.totals.samples, 2);
  assert.equal(analysis.totals.tokens.uncachedInputTokens, 15);
  assert.equal(analysis.totals.tokens.outputTokens, 21);
  assert.equal(analysis.totals.tokens.cacheReadTokens, 30);
  assert.equal(analysis.totals.costMicroCny, 0);
  assert.equal(analysis.totals.costMicroUsd, Math.round(0.03 * 1e6));
  assert.equal(analysis.byModel.length, 2);
  assert.ok(Math.abs(analysis.byModel.reduce((sum, m) => sum + m.share, 0) - 1) < 1e-9);
  assert.equal(analysis.records[0].official, true);
  assert.equal(analysis.records[0].time, 1793400000000);
  assert.equal(analysis.byTurn.length, 0);
});

test('applyOfficialOverlay replaces opencode sessions, skips mixed ones', () => {
  const rows = [
    normalizeLogItem(raw({ id: '1', sessionID: 'session-open', cost: 0.5 })),
    normalizeLogItem(raw({ id: '2', sessionID: 'session-mixed', cost: 0.5 })),
  ];
  const local = {
    totals: { tokens: { uncachedInputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 }, totalTokens: 2, costMicroCny: 1, costCny: 0.000001, samples: 1 },
    byModel: [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }],
  };
  const mixed = {
    totals: { tokens: { uncachedInputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 }, totalTokens: 2, costMicroCny: 1, costCny: 0.000001, samples: 1 },
    byModel: [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, { provider: 'aicodemirror1', model: 'claude-sonnet-5-5' }],
  };
  const results = [
    { meta: { id: 'session-open' }, analysis: local },
    { meta: { id: 'session-mixed' }, analysis: mixed },
    { meta: { id: 'session-none' }, analysis: local },
  ];
  const stats = applyOfficialOverlay(results, { records: rows });
  assert.equal(stats.applied, 1);
  assert.equal(stats.skippedMixed, 1);
  assert.equal(results[0].meta.official, true);
  assert.equal(results[0].analysis.totals.costMicroUsd, Math.round(0.5 * 1e6));
  assert.equal(results[0].analysis.totals.costMicroCny, 0);
  assert.equal(results[0].localAnalysis, local);
  assert.equal(results[1].analysis, mixed);
  assert.equal(results[2].analysis, local);
});

test('summarizeStore reports counts, span and cost', () => {
  const rows = [normalizeLogItem(raw({ id: '1', startedAt: 100, cost: 0.25 })), normalizeLogItem(raw({ id: '2', startedAt: 200, cost: 0.5, sessionID: 'session-other' }))];
  const summary = summarizeStore(rows);
  assert.equal(summary.requests, 2);
  assert.equal(summary.sessions, 2);
  assert.equal(summary.earliest, 100);
  assert.equal(summary.newest, 200);
  assert.equal(summary.costUsd, 0.75);
  assert.equal(recordTokens(rows[1]), 6200);
});

test('buildReport keeps CNY and USD totals apart instead of converting', () => {
  const pricing = { currency: 'CNY', unitTokens: 1_000_000, models: {}, aliases: {} };
  const buckets = { uncachedInputTokens: 10, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 100 };
  const localAnalysis = {
    records: [{ time: 1793400000000, provider: 'opencode-go', model: 'deepseek-v4.1-flash', priced: true, buckets, costMicroCny: 1_000_000, costMicroUsd: 0 }],
    totals: { tokens: { ...buckets }, totalTokens: 115, costMicroCny: 1_000_000, costCny: 1, costMicroUsd: 0, costUsd: 0, cacheHit: 0.9, samples: 1 },
    byModel: [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash', priceKey: 'deepseek-v4.1-flash', priced: true, tokens: { ...buckets }, costMicroCny: 1_000_000, costCny: 1, costMicroUsd: 0, costUsd: 0, share: 1, samples: 1 }],
    byTurn: [],
    unpricedModels: [],
  };
  const officialAnalysis = {
    records: [{ time: 1793400100000, provider: 'opencode', model: 'deepseek-v4.1-flash', priced: true, buckets, costMicroCny: 0, costMicroUsd: 2_500_000 }],
    totals: { tokens: { ...buckets }, totalTokens: 115, costMicroCny: 0, costCny: 0, costMicroUsd: 2_500_000, costUsd: 2.5, cacheHit: 0.9, samples: 1 },
    byModel: [{ provider: 'opencode', model: 'deepseek-v4.1-flash', priceKey: 'opencode-official', priced: true, tokens: { ...buckets }, costMicroCny: 0, costCny: 0, costMicroUsd: 2_500_000, costUsd: 2.5, share: 1, samples: 1 }],
    byTurn: [],
    unpricedModels: [],
  };
  const report = buildReport({
    home: 'test',
    sources: [],
    pricing,
    results: [
      { meta: { id: 'local-1', title: 'local', createdAt: 1793400000000, source: '主机' }, analysis: localAnalysis },
      { meta: { id: 'official-1', title: 'official', createdAt: 1793400100000, source: '主机', official: true }, analysis: officialAnalysis },
    ],
    generatedAt: 1793400200000,
  });
  assert.equal(report.summary.costMicroCny, 1_000_000);
  assert.equal(report.summary.costMicroUsd, 2_500_000);
  assert.equal(report.summary.costCny, 1);
  assert.equal(report.summary.costUsd, 2.5);
  assert.equal(report.sessions.find((s) => s.id === 'official-1').official, true);
  assert.equal(report.sessions.find((s) => s.id === 'local-1').official, false);
  // Day buckets are local-calendar: derive the key instead of hard-coding a
  // date, otherwise the test only passes in UTC+08:00 (it failed on CI's UTC runner).
  const expectedDay = formatDay(localMidnight(1793400100000));
  const day = report.daily.days.find((d) => d.day === expectedDay);
  assert.equal(day.totals.costMicroCny, 1_000_000);
  assert.equal(day.totals.costMicroUsd, 2_500_000);
});

test('official cache saving is priced in USD when rates are configured', () => {
  const rows = [normalizeLogItem(raw({ id: 'c1', cacheReadTokens: 1_000_000, inputTokens: 0, outputTokens: 0, cost: 0.02 }))];
  const analysis = officialAnalysis(rows, { usdRates: { 'deepseek-v4.1-flash': { input: 0.16, output: 0.66, cacheRead: 0.003 } } });
  assert.equal(analysis.totals.cacheSavingMicroUsd, Math.round(1_000_000 * (0.16 - 0.003)));
  assert.equal(analysis.totals.cacheSavingMicro, 0);
  const plain = officialAnalysis(rows);
  assert.equal(plain.totals.cacheSavingMicroUsd, 0);
});

test('the browser dataset carries USD through to the range summary', () => {
  const pricing = { currency: 'CNY', unitTokens: 1_000_000, models: {}, aliases: {} };
  const buckets = { uncachedInputTokens: 10, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 100 };
  const report = buildReport({
    home: 'test',
    sources: [],
    pricing,
    results: [
      {
        meta: { id: 'official-1', title: 'off', createdAt: 1793400000000, source: '主机', official: true },
        analysis: {
          records: [{ time: 1793400000000, provider: 'opencode', model: 'deepseek-v4.1-flash', priceKey: 'opencode-official', priced: true, buckets, costMicroCny: 0, costMicroUsd: 2_500_000 }],
          totals: { tokens: { ...buckets }, totalTokens: 115, costMicroCny: 0, costCny: 0, costMicroUsd: 2_500_000, costUsd: 2.5, cacheHit: 0.9, samples: 1 },
          byModel: [{ provider: 'opencode', model: 'deepseek-v4.1-flash', priceKey: 'opencode-official', priced: true, tokens: { ...buckets }, costMicroCny: 0, costCny: 0, costMicroUsd: 2_500_000, costUsd: 2.5, cacheSavingMicroUsd: 16_000, share: 1, samples: 1 }],
          byTurn: [],
          unpricedModels: [],
        },
      },
    ],
    generatedAt: 1793400200000,
  });
  const dataset = buildTimeRangeDataset({ sessions: report.sessions, pricing, daily: report.daily });
  assert.equal(dataset.sessions[0].costMicroUsd, 2_500_000, 'session row keeps USD');
  assert.equal(dataset.sessions[0].models[0].costMicroUsd, 2_500_000, 'model row keeps USD');
  assert.equal(dataset.sessions[0].models[0].cacheSavingMicro, 0, 'official rows must not claim CNY savings');
  assert.equal(dataset.sessions[0].models[0].cacheSavingMicroUsd, 16_000);
  const stats = aggregateRangeStats(dataset.sessions);
  assert.equal(stats.costMicroUsd, 2_500_000, 'range summary keeps USD');
  assert.equal(stats.costMicroCny, 0);
  assert.equal(stats.cacheSavingMicroUsd, 16_000);
  // The official marker must survive into the dataset, otherwise the browser
  // would average official tokens into the CNY column.
  assert.equal(dataset.sessions[0].models[0].priceKey, 'opencode-official');
  assert.equal(stats.tokenPrice.cnyTokens, 0);
  assert.equal(stats.tokenPrice.usdTokens, 115);
  assert.ok(stats.tokenPrice.usdMicroPerM > 0);
  // The daily (按天) view must classify the same rows the same way.
  const dayModel = dataset.days.flatMap((day) => day.sessions).flatMap((session) => session.models).find((model) => model.priceKey === 'opencode-official');
  assert.ok(dayModel, 'daily dataset keeps the official marker');
  const dayStats = aggregateDayStats(dataset.days);
  assert.equal(dayStats.tokenPrice.cnyTokens, 0);
  assert.equal(dayStats.tokenPrice.usdTokens, 115);
  assert.equal(dayStats.tokenPrice.usdMicroPerM, stats.tokenPrice.usdMicroPerM);
  assert.ok(report.summary.tokenPrice.usdMicroPerM > 0, 'summary carries the USD average');
});

test('live fragments carry a fresh dataset so cards do not freeze', () => {
  const pricing = { currency: 'CNY', unitTokens: 1_000_000, models: {}, aliases: {} };
  const buckets = { uncachedInputTokens: 10, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 100 };
  const report = buildReport({
    home: 'test',
    sources: [],
    pricing,
    results: [
      {
        meta: { id: 'official-2', title: 'off', createdAt: 1793400000000, source: '主机', official: true },
        analysis: {
          records: [{ time: 1793400000000, provider: 'opencode', model: 'deepseek-v4.1-flash', priceKey: 'opencode-official', priced: true, buckets, costMicroCny: 0, costMicroUsd: 2_500_000 }],
          totals: { tokens: { ...buckets }, totalTokens: 115, costMicroCny: 0, costCny: 0, costMicroUsd: 2_500_000, costUsd: 2.5, cacheHit: 0.9, samples: 1 },
          byModel: [{ provider: 'opencode', model: 'deepseek-v4.1-flash', priceKey: 'opencode-official', priced: true, tokens: { ...buckets }, costMicroCny: 0, costCny: 0, costMicroUsd: 2_500_000, costUsd: 2.5, share: 1, samples: 1 }],
          byTurn: [],
          unpricedModels: [],
        },
      },
    ],
    generatedAt: 1793400200000,
  });
  const fragment = renderLiveFragment(report);
  assert.equal(fragment.dataset.sessions[0].costMicroUsd, 2_500_000);
  assert.equal(fragment.dataset.sessions[0].models[0].costMicroUsd, 2_500_000);
  assert.ok(fragment.html.includes('$2.5000'), 'server card shows the USD half');
  assert.equal(fragment.summary.costUsd, 2.5);
});

test('daily buckets aggregate every sample of a session, not just the last', () => {
  const pricing = { currency: 'CNY', unitTokens: 1_000_000, models: { 'deepseek-v4.1-flash': { input: 0.15, output: 0.6, cacheWrite: 0.15, cacheRead: 0.003 } }, aliases: {} };
  const buckets = { uncachedInputTokens: 10, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 100 };
  const record = (time) => ({ time, provider: 'opencode', model: 'deepseek-v4.1-flash', priceKey: 'opencode-official', priced: true, buckets, costMicroCny: 0, costMicroUsd: 1_000_000 });
  const records = [record(1793400000000), record(1793400600000), record(1793401200000)];
  const report = buildReport({
    home: 'test',
    sources: [],
    pricing,
    results: [
      {
        meta: { id: 'multi-1', title: 'multi', createdAt: 1793400000000, source: '主机', official: true },
        analysis: {
          records,
          totals: { tokens: { uncachedInputTokens: 30, outputTokens: 15, cacheWriteTokens: 0, cacheReadTokens: 300 }, totalTokens: 345, costMicroCny: 0, costCny: 0, costMicroUsd: 3_000_000, costUsd: 3, cacheHit: 0.9, samples: 3 },
          byModel: [],
          byTurn: [],
          unpricedModels: [],
        },
      },
    ],
    generatedAt: 1793402000000,
  });
  const day = report.daily.days.find((d) => d.unknown !== true && d.sessions.length === 1);
  assert.equal(day.totals.cacheReadTokens, 300);
  assert.equal(day.sessions[0].tokens.cacheReadTokens, 300, 'session keeps all samples');
  assert.equal(day.sessions[0].costMicroUsd, 3_000_000);
  assert.equal(day.sessions[0].models[0].tokens.cacheReadTokens, 300);
});

test('console failures are classified for the loop and the page', () => {
  const forbidden = describeSyncFailure(403, '{"_tag":"Forbidden"}');
  assert.equal(forbidden.kind, 'forbidden');
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.tag, 'Forbidden');
  assert.match(forbidden.hint, /Personal API key/u);
  // A 403 is a permission problem for this credential, not proof that no key
  // can read the console: a key with the required scope does read it.
  assert.doesNotMatch(forbidden.hint, /只能调用推理/u);
  assert.match(forbidden.hint, /权限/u);
  assert.match(forbidden.hint, /scope/u);
  assert.match(forbidden.hint, /工作区/u);
  const missing = describeSyncFailure(401, '{"_tag":"Unauthorized"}');
  assert.equal(missing.kind, 'unauthorized');
  assert.match(missing.hint, /OPENCODE_GO_API_KEY/u);
  assert.equal(describeSyncFailure(429).kind, 'transient');
  assert.equal(describeSyncFailure(500).kind, 'transient');
  assert.equal(describeSyncFailure(502).kind, 'transient');
  const other = describeSyncFailure(404, 'nope');
  assert.equal(other.kind, 'http');
  assert.equal(other.tag, null);
});

test('a refused credential backs off instead of retrying every interval', () => {
  assert.equal(nextSyncDelay(60_000, null), 60_000);
  assert.equal(nextSyncDelay(60_000, { kind: 'transient' }), 60_000);
  assert.equal(nextSyncDelay(60_000, { kind: 'forbidden' }), 300_000);
  assert.equal(nextSyncDelay(60_000, { kind: 'unauthorized' }), 300_000);
  // A slower interval already exceeds the floor and must not be shortened.
  assert.equal(nextSyncDelay(600_000, { kind: 'forbidden' }), 600_000);
});

test('--check-auth reports the rejection without printing the key', async () => {
  const config = { apiBase: 'https://console.invalid', credentials: '/nonexistent/credentials.yaml', product: null };
  const key = 'test-key-not-real';
  const response = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body });
  const originalFetch = globalThis.fetch;
  const previous = process.env.OPENCODE_GO_API_KEY;
  process.env.OPENCODE_GO_API_KEY = key;
  const seen = [];
  try {
    const run = async (status, body) => {
      const lines = [];
      let requested = '';
      globalThis.fetch = async (url) => {
        requested = String(url);
        return response(status, body);
      };
      const code = await checkAuth(config, { log: (line) => lines.push(line) });
      seen.push(requested);
      return { code, lines };
    };
    const ok = await run(200, '{"items":[]}');
    assert.equal(ok.code, 0);
    assert.match(ok.lines.join('\n'), /auth ok/u);
    assert.match(seen[0], /request-logs/u);
    assert.match(seen[0], /limit=1/u);
    const forbidden = await run(403, '{"_tag":"Forbidden"}');
    assert.equal(forbidden.code, 3);
    const forbiddenText = forbidden.lines.join('\n');
    assert.match(forbiddenText, /HTTP 403/u);
    assert.match(forbiddenText, /Personal API key/u);
    assert.doesNotMatch(forbiddenText, /只能调用推理/u);
    const unauthorized = await run(401, '{"_tag":"Unauthorized"}');
    assert.equal(unauthorized.code, 4);
    assert.match(unauthorized.lines.join('\n'), /OPENCODE_GO_API_KEY/u);
    for (const result of [ok, forbidden, unauthorized]) {
      assert.ok(result.lines.every((line) => !line.includes(key)), 'the key itself is never logged');
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.OPENCODE_GO_API_KEY;
    else process.env.OPENCODE_GO_API_KEY = previous;
  }
});

test('a rejected key is named instead of blaming a stopped loop', () => {
  const pricing = { currency: 'CNY', unitTokens: 1_000_000, models: {}, aliases: {} };
  const buckets = { uncachedInputTokens: 10, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 100 };
  const generatedAt = 1793400200000;
  const report = buildReport({
    home: 'test',
    sources: [],
    pricing,
    results: [
      {
        meta: { id: 'sync-note', title: 'sync', createdAt: 1793400000000, source: '主机', official: true },
        analysis: {
          records: [{ time: 1793400000000, provider: 'opencode', model: 'deepseek-v4.1-flash', priceKey: 'opencode-official', priced: true, buckets, costMicroCny: 0, costMicroUsd: 1_000_000 }],
          totals: { tokens: { ...buckets }, totalTokens: 115, costMicroCny: 0, costCny: 0, costMicroUsd: 1_000_000, costUsd: 1, cacheHit: 0.9, samples: 1 },
          byModel: [{ provider: 'opencode', model: 'deepseek-v4.1-flash', priceKey: 'opencode-official', priced: true, tokens: { ...buckets }, costMicroCny: 0, costCny: 0, costMicroUsd: 1_000_000, costUsd: 1, share: 1, samples: 1 }],
          byTurn: [],
          unpricedModels: [],
        },
      },
    ],
    generatedAt,
  });
  const official = {
    store: '/tmp/store',
    requests: 10,
    sessions: 1,
    skippedMixed: 0,
    windows: { today: 1, '7d': 2, '30d': 3, all: 3 },
    storeUpdatedAt: generatedAt - 42 * 60_000,
    syncError: null,
  };
  // The page also embeds the client-side string table, so assertions have to
  // read the console note itself, not the whole document.
  const consoleNoteOf = (html) => /<div class="note[^"]*">([^<]*官方口径[^<]*)<\/div>/u.exec(html)?.[1] ?? '';
  assert.match(consoleNoteOf(renderHtml({ ...report, official })), /同步循环可能已停止/u);
  const rejected = renderHtml({ ...report, official: { ...official, syncError: { at: generatedAt, status: 403, kind: 'forbidden', message: 'HTTP 403 Forbidden' } } });
  assert.match(consoleNoteOf(rejected), /HTTP 403/u);
  assert.match(consoleNoteOf(rejected), /Personal API key/u);
  assert.match(consoleNoteOf(rejected), /scope/u);
  assert.doesNotMatch(consoleNoteOf(rejected), /只能调用推理/u);
  assert.doesNotMatch(consoleNoteOf(rejected), /同步循环可能已停止/u);
  const missing = renderHtml({ ...report, official: { ...official, syncError: { at: generatedAt, status: 401, kind: 'unauthorized', message: 'HTTP 401 Unauthorized' } } });
  assert.match(consoleNoteOf(missing), /OPENCODE_GO_API_KEY/u);
});

test('official windows: today is the local day, 7/30 days are rolling', () => {
  const now = new Date('2026-11-01T02:00:00+08:00').getTime();
  const at = (hoursAgo, usd) => ({ startedAt: now - hoursAgo * 3600_000, finishedAt: now - hoursAgo * 3600_000 + 1000, costUsd: usd });
  const totals = officialWindowTotals([at(1, 0.5), at(26, 2), at(24 * 8, 4)], now);
  assert.equal(totals.today, 0.5, 'only the request after local midnight counts as today');
  assert.equal(totals['7d'], 2.5);
  assert.equal(totals['30d'], 6.5);
  assert.equal(officialWindowTotals([], now), null);
});
