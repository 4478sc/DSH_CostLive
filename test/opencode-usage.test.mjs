import test from 'node:test';
import assert from 'node:assert/strict';
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

test('officialAnalysis mirrors the engine shape and converts USD to CNY', () => {
  const rows = [
    normalizeLogItem(raw({ id: '1', cost: 0.01, inputTokens: 10, outputTokens: 20, cacheReadTokens: 30 })),
    normalizeLogItem(raw({ id: '2', cost: 0.02, inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, model: 'other' })),
    normalizeLogItem(raw({ id: '3', cost: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 })),
  ];
  const analysis = officialAnalysis(rows, { fxUsdCny: 7 });
  assert.equal(analysis.totals.samples, 2);
  assert.equal(analysis.totals.tokens.uncachedInputTokens, 15);
  assert.equal(analysis.totals.tokens.outputTokens, 21);
  assert.equal(analysis.totals.tokens.cacheReadTokens, 30);
  assert.equal(analysis.totals.costMicroCny, Math.round(0.03 * 7 * 1e6));
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
  const stats = applyOfficialOverlay(results, { records: rows, fxUsdCny: 7 });
  assert.equal(stats.applied, 1);
  assert.equal(stats.skippedMixed, 1);
  assert.equal(results[0].meta.official, true);
  assert.equal(results[0].analysis.totals.costMicroCny, Math.round(0.5 * 7 * 1e6));
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
