import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../src/report-data.mjs';
import {
  applyOfficialOverlay,
  groupBySession,
  mergeOfficialRecords,
  normalizeLogItem,
  officialAnalysis,
  recordTokens,
  sessionKey,
  summarizeStore,
} from '../src/opencode-usage.mjs';

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
  const day = report.daily.days.find((d) => d.day === '2026-10-31');
  assert.equal(day.totals.costMicroCny, 1_000_000);
  assert.equal(day.totals.costMicroUsd, 2_500_000);
});
