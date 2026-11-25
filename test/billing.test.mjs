import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { billingPeriods, normalizeBilling, shanghaiDay, subscriptionReport, billingRuntimeSource } from '../src/billing.mjs';
import { providerUsage } from '../src/billing-report.mjs';
import { loadBilling, saveBilling } from '../src/billing-config.mjs';
import { collectLiveReport, renderLiveDocument, renderLiveFragment } from '../src/live.mjs';
import { startLiveServer } from '../src/live-server.mjs';
import { toCsv } from '../src/report-data.mjs';
import { renderHtml } from '../src/report-html.mjs';
import { timeRangeRuntimeSource } from '../src/time-range.mjs';
import { MESSAGES } from '../src/i18n.mjs';
import { billingClientSource, billingSettings, realBody } from '../src/billing-ui.mjs';
import { main } from '../src/cli.mjs';
const at = (day) => Date.parse(day + 'T12:00:00+08:00');
/** One day of one payment, computed independently of the implementation. */
const share = (amount, index, days) => Math.round(amount * 1e6 * index / days) - Math.round(amount * 1e6 * (index - 1) / days);
const paidUpTo = (amount, index, days) => Math.round(amount * 1e6 * index / days);
const real = (opencode, codex = [{ effectiveFrom: '2026-11-01', monthlyUsd: 0 }]) => normalizeBilling({ mode: 'real', subscriptions: { opencode, codex } });
const config = (start = '2026-11-01', a = 30, b = 60) => real([{ effectiveFrom: start, monthlyUsd: a }], [{ effectiveFrom: start, monthlyUsd: b }]);
const renewed = (start = '2026-10-01', next = '2026-11-01', a = 30, b = 60) => real(
  [{ effectiveFrom: start, monthlyUsd: a }, { effectiveFrom: next, monthlyUsd: a }],
  [{ effectiveFrom: start, monthlyUsd: b }, { effectiveFrom: next, monthlyUsd: b }],
);
const tokens = (n) => ({ uncachedInputTokens: n, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: n });
const rowCost = (day, provider = 'opencode') => day.providers.find((row) => row.provider === provider)?.costMicroUsd ?? 0;
const rowIdle = (day, provider = 'opencode') => day.providers.find((row) => row.provider === provider)?.idleMicroUsd ?? 0;
const findDay = (report, day) => report.days.find((entry) => entry.day === day);
const providerCost = (report, provider = 'opencode') => report.days.reduce((sum, day) => sum + rowCost(day, provider), 0);

test('subscription configuration accepts any calendar start, validates dates, cents and duplicates', () => {
  assert.equal(normalizeBilling().mode, 'usage');
  assert.throws(() => normalizeBilling({ mode: 'real' }));
  for (const amount of [-1, NaN, Infinity, '20', 0.001]) assert.throws(() => config('2026-11-01', amount));
  assert.throws(() => config('2026-02-30'));
  assert.throws(() => normalizeBilling({ mode: 'usage', timeZone: 'UTC' }));
  // A mid-month renewal is an ordinary record now: no first-of-month rule.
  const value = config();
  value.subscriptions.codex.push({ effectiveFrom: '2026-12-02', monthlyUsd: 50 });
  const normalized = normalizeBilling(value);
  assert.deepEqual(normalized.subscriptions.codex.map((row) => row.effectiveFrom), ['2026-11-01', '2026-12-02']);
  assert.equal(normalized.version, 1);
  assert.equal(normalized.timeZone, 'Asia/Shanghai');
  // The same provider cannot start two records on one day.
  normalized.subscriptions.codex.push({ effectiveFrom: '2026-12-02', monthlyUsd: 10 });
  assert.throws(() => normalizeBilling(normalized), /Duplicate effective date/);
  // A same-price renewal is recorded as two ordinary payments.
  const samePrice = real([{ effectiveFrom: '2026-11-01', monthlyUsd: 20 }, { effectiveFrom: '2026-12-01', monthlyUsd: 20 }]);
  assert.equal(samePrice.subscriptions.opencode.length, 2);
  // Input order never matters; records are sorted, not rejected.
  const unsorted = real([{ effectiveFrom: '2026-12-01', monthlyUsd: 20 }, { effectiveFrom: '2026-11-01', monthlyUsd: 20 }]);
  assert.deepEqual(unsorted.subscriptions.opencode.map((row) => row.effectiveFrom), ['2026-11-01', '2026-12-01']);
  // A record without a following record is not duplicated into an implicit renewal.
  assert.equal(unsorted.subscriptions.codex.length, 1);
});

test('one record is one period: same day next month, clamped to the month end, billed to the cent', () => {
  const cases = [
    ['2026-02-01', '2026-03-01', 29],
    ['2028-02-01', '2028-03-01', 30],
    ['2026-11-01', '2026-12-01', 31],
    ['2026-12-01', '2027-01-01', 32],
    ['2026-01-31', '2026-02-28', 29],
    ['2028-01-31', '2028-02-29', 30],
    ['2026-03-31', '2026-04-30', 31],
    ['2026-05-15', '2026-06-15', 32],
    ['2026-12-20', '2027-01-20', 32],
  ];
  for (const [start, end, days] of cases) {
    const [period] = billingPeriods([{ effectiveFrom: start, monthlyUsd: 19.99 }]);
    assert.equal(period.start, start);
    assert.equal(period.end, end, start + ' end');
    assert.equal(period.days, days, start + ' days');
    const report = subscriptionReport([], real([{ effectiveFrom: start, monthlyUsd: 19.99 }], [{ effectiveFrom: start, monthlyUsd: 0 }]), { now: at(end) });
    assert.equal(report.days.length, days);
    assert.equal(report.days[0].day, end);
    assert.equal(report.summary.costMicroUsd, 19990000, start + ' total equals the payment');
    assert.equal(report.summary.idleMicroUsd, 19990000);
    assert.equal(report.summary.tokenPrice.usdMicroPerM, null);
    // Every day's share is the cumulative rounded difference, so no day is lost.
    assert.equal(findDay(report, start).providers[0].costMicroUsd, share(19.99, 1, days));
  }
});

test('nothing renews implicitly: the day after a period ends costs nothing', () => {
  const report = subscriptionReport([], real([{ effectiveFrom: '2026-11-01', monthlyUsd: 30 }]), { now: at('2026-12-15') });
  assert.equal(report.days.length, 31);
  assert.equal(report.days[0].day, '2026-12-01');
  assert.equal(report.days[report.days.length - 1].day, '2026-11-01');
  assert.equal(report.summary.costMicroUsd, 30000000);
  assert.equal(report.days.some((day) => day.day > '2026-12-01'), false);
});

test('a same-day renewal moves the expiry day into the new period only', () => {
  const history = [{ effectiveFrom: '2026-11-01', monthlyUsd: 30 }, { effectiveFrom: '2026-12-01', monthlyUsd: 30 }];
  const periods = billingPeriods(history);
  assert.deepEqual(periods.map((period) => [period.start, period.end, period.days]), [
    ['2026-11-01', '2026-11-30', 30],
    ['2026-12-01', '2027-01-01', 32],
  ]);
  const report = subscriptionReport([], real(history), { now: at('2027-01-15') });
  const november = report.days.filter((day) => day.day < '2026-12-01').reduce((sum, day) => sum + rowCost(day), 0);
  const december = report.days.filter((day) => day.day >= '2026-12-01').reduce((sum, day) => sum + rowCost(day), 0);
  assert.equal(november, 30000000);
  assert.equal(december, 30000000);
  assert.equal(rowCost(findDay(report, '2026-11-30')), share(30, 30, 30));
  assert.equal(rowCost(findDay(report, '2026-12-01')), share(30, 1, 32), 'the renewal day is charged once, by the new period');
  assert.equal(findDay(report, '2026-12-01').providers.filter((row) => row.provider === 'opencode').length, 1);
});

test('a late renewal keeps the expiry day and leaves an unbilled gap that costs nothing', () => {
  const history = [{ effectiveFrom: '2026-11-01', monthlyUsd: 30 }, { effectiveFrom: '2026-12-10', monthlyUsd: 30 }];
  const periods = billingPeriods(history);
  assert.deepEqual(periods.map((period) => [period.start, period.end, period.days]), [
    ['2026-11-01', '2026-12-01', 31],
    ['2026-12-10', '2027-01-10', 32],
  ]);
  const report = subscriptionReport([], real(history), { now: at('2027-01-15') });
  assert.equal(report.days.length, 31 + 32);
  assert.equal(report.days.some((day) => day.day > '2026-12-01' && day.day < '2026-12-10'), false);
  assert.equal(rowCost(findDay(report, '2026-12-01')), share(30, 31, 31), 'the expiry day stays with the old period');
  assert.equal(providerCost(report), 60000000);
  // Usage inside the gap still appears, without any subscription cost.
  const gapped = subscriptionReport([{ day: '2026-12-05', provider: 'opencode', tokens: tokens(10) }], real(history), { now: at('2027-01-15') });
  assert.equal(rowCost(findDay(gapped, '2026-12-05')), 0);
  assert.equal(rowIdle(findDay(gapped, '2026-12-05')), 0);
  assert.equal(findDay(gapped, '2026-12-05').providers[0].configured, true);
});

test('an earlier renewal truncates the old period and still charges its whole payment', () => {
  const history = [{ effectiveFrom: '2026-11-01', monthlyUsd: 30 }, { effectiveFrom: '2026-11-20', monthlyUsd: 45 }];
  const periods = billingPeriods(history);
  assert.deepEqual(periods.map((period) => [period.start, period.end, period.days]), [
    ['2026-11-01', '2026-11-19', 19],
    ['2026-11-20', '2026-12-20', 31],
  ]);
  const report = subscriptionReport([], real(history), { now: at('2026-12-31') });
  const old = report.days.filter((day) => day.day < '2026-11-20').reduce((sum, day) => sum + rowCost(day), 0);
  const next = report.days.filter((day) => day.day >= '2026-11-20').reduce((sum, day) => sum + rowCost(day), 0);
  assert.equal(old, 30000000, 'the old payment is spread over the days it actually covers');
  assert.equal(next, 45000000);
  assert.equal(report.summary.costMicroUsd, 75000000);
  // Only the newer record owns the renewal day, so no provider day is billed twice.
  assert.equal(rowCost(findDay(report, '2026-11-20')), share(45, 1, 31));
  assert.equal(rowCost(findDay(report, '2026-11-19')), share(30, 19, 19));
  assert.ok(rowCost(findDay(report, '2026-11-19')) > rowCost(findDay(report, '2026-11-20')), 'a shortened period raises its daily rate');
  // Another provider never truncates this provider's period.
  const mixed = real(history, [{ effectiveFrom: '2026-11-05', monthlyUsd: 60 }]);
  assert.deepEqual(billingPeriods(mixed.subscriptions.opencode).map((period) => period.days), [19, 31]);
  assert.deepEqual(billingPeriods(mixed.subscriptions.codex).map((period) => period.days), [31]);
  const both = subscriptionReport([], mixed, { now: at('2026-12-20') });
  assert.equal(rowCost(findDay(both, '2026-11-19')), share(30, 19, 19));
  assert.equal(rowCost(findDay(both, '2026-11-19'), 'codex'), share(60, 15, 31));

});

test('the daily share divides by the full period, never by the filter window or today', () => {
  const cfg = real([{ effectiveFrom: '2026-11-01', monthlyUsd: 30 }]);
  const all = subscriptionReport([], cfg, { now: at('2026-11-30') });
  const today = subscriptionReport([], cfg, { now: at('2026-11-15'), range: 'today' });
  const week = subscriptionReport([], cfg, { now: at('2026-11-15'), range: '7d' });
  const bounds = subscriptionReport([], cfg, { now: at('2026-11-30'), since: '2026-11-14', until: '2026-11-15' });
  const expected = share(30, 15, 31);
  for (const report of [all, today, week, bounds]) {
    assert.equal(rowCost(findDay(report, '2026-11-15')), expected);
  }
  assert.equal(today.days.length, 1);
  assert.equal(week.days.length, 7);
  assert.equal(bounds.days.length, 2);
  assert.equal(bounds.summary.costMicroUsd, share(30, 14, 31) + share(30, 15, 31));
  assert.equal(all.summary.costMicroUsd, paidUpTo(30, 30, 31));
  // A moved window keeps the same daily share: the 7-day total is the sum of its own days.
  assert.equal(week.summary.costMicroUsd, paidUpTo(30, 15, 31) - paidUpTo(30, 8, 31));
});

test('Shanghai calendar days include today and never add future spend', () => {
  assert.equal(shanghaiDay(Date.parse('2026-11-01T15:59:59Z')), '2026-11-01');
  assert.equal(shanghaiDay(Date.parse('2026-11-01T16:00:00Z')), '2026-11-02');
  const report = subscriptionReport([], config(), { now: Date.parse('2026-11-01T16:00:00Z'), range: 'today' });
  assert.equal(report.until, '2026-11-02');
  assert.equal(report.days.length, 1);
  assert.equal(findDay(report, '2026-11-02').providers[0].costMicroUsd, share(30, 2, 31));
  const capped = subscriptionReport([], config(), { now: at('2026-11-12'), until: '2026-11-30' });
  assert.equal(capped.until, '2026-11-12');
  assert.equal(capped.days.length, 12);
  assert.throws(() => subscriptionReport([], config(), { since: '2026-02-30', now: at('2026-11-01') }));
  assert.throws(() => subscriptionReport([], config(), { since: '2026-11-12', until: '2026-11-01', now: at('2026-11-20') }));
});

test('providers keep token averages while currency and idle cost stay separate', () => {
  const sample = (provider, n) => ({ provider, time: at('2026-11-01'), buckets: tokens(n), priceKey: 'usd-example', priced: true, costMicroUsd: 999999 });
  const results = [
    { meta: { source: 'host', id: 'one' }, analysis: { records: [sample('host-codex', 100)] } },
    { meta: { source: 'vm', id: 'two' }, analysis: { records: [sample('openai', 200)] } },
    { meta: { source: 'vm', id: 'three' }, localAnalysis: { records: [sample('opencode-go', 400)] }, analysis: { records: [sample('opencode', 1)] } },
  ];
  const usage = providerUsage(results);
  const report = subscriptionReport(usage, config(), { now: at('2026-11-01') });
  assert.equal(report.summary.costMicroUsd, share(30, 1, 31) + share(60, 1, 31));
  assert.equal(report.summary.tokens.totalTokens, 700);
  const codex = report.providers.find((row) => row.provider === 'codex');
  assert.equal(codex.tokens.totalTokens, 300);
  assert.equal(codex.tokenPrice.usdMicroPerM, Math.round(codex.costMicroUsd * 1e6 / 300));
  assert.equal(report.modelCostsAllocated, false);
  assert.equal(report.sessionCostsAllocated, false);
  const mixed = subscriptionReport([
    { day: '2026-11-01', provider: 'codex', tokens: tokens(1000000), sessionIds: ['host:a'] },
    { day: '2026-11-01', provider: 'proxy', tokens: tokens(1000000), costMicroCny: 2000000, cnyTokens: 1000000 },
  ], config(), { now: at('2026-11-02') });
  assert.equal(mixed.summary.costMicroCny, 2000000);
  assert.equal(mixed.summary.costMicroUsd, paidUpTo(30, 2, 31) + paidUpTo(60, 2, 31));
  assert.equal(mixed.summary.tokenPrice.cnyMicroPerM, 2000000);
  assert.equal(mixed.summary.tokenPrice.usdMicroPerM, mixed.summary.costMicroUsd);
  // codex bills both days but only day 2 is idle; opencode has no usage at all.
  assert.equal(mixed.summary.idleMicroUsd, paidUpTo(30, 2, 31) + share(60, 2, 31));
  const missing = subscriptionReport([{ day: '2026-10-31', provider: 'codex', tokens: tokens(10) }], config(), { now: at('2026-11-01') });
  assert.equal(missing.summary.configured, false);
  assert.equal(missing.summary.tokenPrice.usdMicroPerM, null);
});

test('legacy version-1 files keep their dates and amounts and are read as per-payment records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'costlive-billing-legacy-'));
  const file = join(dir, 'billing.json');
  const legacy = { version: 1, mode: 'real', timeZone: 'Asia/Shanghai', subscriptions: {
    opencode: [{ effectiveFrom: '2026-11-01', monthlyUsd: 20 }, { effectiveFrom: '2026-12-01', monthlyUsd: 30 }],
    codex: [{ effectiveFrom: '2026-11-01', monthlyUsd: 100 }],
  } };
  try {
    writeFileSync(file, JSON.stringify(legacy, null, 2));
    const loaded = loadBilling(file);
    assert.deepEqual(loaded, normalizeBilling(legacy), 'existing records are read verbatim, never copied');
    assert.equal(loaded.subscriptions.codex.length, 1, 'no renewal was invented for codex');
    const report = subscriptionReport([], loaded, { now: at('2026-12-31') });
    assert.equal(providerCost(report, 'codex'), 100000000);
    assert.equal(report.days.filter((day) => rowCost(day, 'codex') > 0).length, 31);
    assert.equal(providerCost(report, 'opencode'), 20000000 + paidUpTo(30, 31, 32));
    // An explicit save keeps the same shape and accepts a mid-month start.
    saveBilling(file, { mode: 'real', subscriptions: { opencode: [{ effectiveFrom: '2026-11-15', monthlyUsd: 12.5 }], codex: [{ effectiveFrom: '2026-11-15', monthlyUsd: 0 }] } });
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(saved, { version: 1, mode: 'real', timeZone: 'Asia/Shanghai', subscriptions: { opencode: [{ effectiveFrom: '2026-11-15', monthlyUsd: 12.5 }], codex: [{ effectiveFrom: '2026-11-15', monthlyUsd: 0 }] } });
    assert.equal(loadBilling(file).mode, 'real');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('billing runtime produces the same provider/day report in a browser realm', () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(billingRuntimeSource(), context);
  const billing = renewed();
  const args = [[], billing, { now: at('2026-11-12'), range: '7d' }];
  assert.deepEqual(JSON.parse(JSON.stringify(context.window.DSH_BILLING.calculate(...args))), subscriptionReport(...args));
  assert.deepEqual(JSON.parse(JSON.stringify(context.window.DSH_BILLING.periods(billing.subscriptions.opencode))), billingPeriods(billing.subscriptions.opencode));
});

test('billing settings show each payment, its covered days and the new copy', () => {
  const settings = billingSettings(renewed(), 'zh');
  assert.match(settings, /单期订阅实付（USD）/);
  assert.match(settings, /本期生效日/);
  assert.match(settings, /覆盖 2026-10-01 → 2026-10-31（含）· 31 天/);
  assert.match(settings, /覆盖 2026-11-01 → 2026-12-01（含）· 31 天/);
  assert.equal((settings.match(/<fieldset data-billing-provider=/g) || []).length, 2);
  assert.match(billingSettings(config(), 'en'), /Covers 2026-11-01 → 2026-12-01 \(inclusive\) · 31 days/);
  const script = billingClientSource();
  assert.match(script, /billing\.period/);
  assert.match(script, /billing\.duplicate/);
  assert.match(script, /billing\.needAmount/);
  assert.match(script, /api\.periods/);
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'costlive-billing-')); const home = join(dir, 'home'); const session = join(home, 'sessions', 'workspace', 'billing-session'); mkdirSync(session, { recursive: true });
  const lines = [{ type: 'session', version: 4, id: 'billing-session', createdAt: at('2026-10-01'), cwd: '/demo' }, { type: 'model/selection', seq: 0, time: at('2026-11-01'), data: { provider: 'opencode-go', model: 'demo' } }, { type: 'assistant/message', seq: 1, time: at('2026-11-01'), data: { turn: 1, step: 1, usage: { inputTokens: 500, outputTokens: 100 } } }];
  writeFileSync(join(session, 'session.v4.jsonl.zstd'), Buffer.concat(lines.map((x) => zstdCompressSync(Buffer.from(JSON.stringify(x) + '\n')))));
  return { dir, home, billingPath: join(dir, 'billing.json') };
}

test('local config saves atomically and real live/CSV/static reports use the shared pipeline', () => {
  const f = fixture(); try {
    saveBilling(f.billingPath, config()); assert.equal(loadBilling(f.billingPath).mode, 'real');
    const report = collectLiveReport({ home: f.home, billingPath: f.billingPath, since: '2026-11-01', until: '2026-11-02', official: false });
    const expected = (paidUpTo(30, 2, 31) + paidUpTo(60, 2, 31)) / 1e6;
    assert.ok(Math.abs(report.summary.costUsd - expected) < 1e-9);
    assert.equal(report.summary.totalTokens, 600); assert.equal(report.sessions.length, 0); assert.equal(report.referenceUsage.sessions.length, 1);
    assert.match(toCsv(report), /billing_mode/); assert.match(toCsv(report), /TOTAL/);
    const html = renderHtml(report, { locale: 'en' });
    assert.match(html, /data-billing-mode="usage"/); assert.match(html, /data-billing-mode="real"/);
    assert.doesNotMatch(html, /data-billing-export|data-billing-import|data-real-export/);
    assert.match(html, /<th class="num">Token<\/th>/);
    assert.match(html, /Covers 2026-11-01 → 2026-12-01 \(inclusive\) · 31 days/);
    assert.match(html, /Costs by provider/); assert.match(renderLiveDocument({ report, locale: 'en' }), /billing-form/);
    assert.equal(renderLiveFragment(report).dataset.billing.config.mode, 'real');
    const output = join(f.dir, 'report.json');
    assert.equal(main(['report', '--home', f.home, '--billing', f.billingPath, '--since', '2026-11-01', '--until', '2026-11-02', '--format', 'json', '--out', output]), 0);
    const cli = JSON.parse(readFileSync(output, 'utf8')); assert.equal(cli.summary.costUsd, report.summary.costUsd); assert.equal(cli.summary.totalTokens, report.summary.totalTokens);
    assert.throws(() => collectLiveReport({ home: f.home, billingPath: f.billingPath, model: 'demo' }), /complete subscription scope/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('billing API accepts mid-month renewals, rejects duplicates and keeps saved history', async () => {
  const f = fixture();
  const live = await startLiveServer({ port: 0, open: false, logger: { log() { }, warn() { } }, reportOptions: { home: f.home, billingPath: f.billingPath, official: false } });
  try {
    const send = (value, headers = {}) => fetch(live.url + 'api/billing', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Origin': live.url.slice(0, -1), 'X-CostLive-Settings': '1', ...headers }, body: JSON.stringify(value) });
    const mid = { mode: 'real', subscriptions: { opencode: [{ effectiveFrom: '2026-11-01', monthlyUsd: 20 }, { effectiveFrom: '2026-11-15', monthlyUsd: 20 }], codex: [{ effectiveFrom: '2026-11-10', monthlyUsd: 100 }] } };
    assert.equal((await send(mid, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await send(mid, { 'X-CostLive-Settings': '' })).status, 403);
    assert.equal((await send({ mode: 'real' })).status, 400);
    assert.equal((await send({ ...mid, subscriptions: { ...mid.subscriptions, codex: [{ effectiveFrom: '2026-11-31', monthlyUsd: 1 }] } })).status, 400);
    assert.equal((await send({ ...mid, subscriptions: { ...mid.subscriptions, codex: [{ effectiveFrom: '2026-11-10', monthlyUsd: 100 }, { effectiveFrom: '2026-11-10', monthlyUsd: 100 }] } })).status, 400);
    assert.equal((await send(mid)).status, 200);
    assert.deepEqual(loadBilling(f.billingPath), normalizeBilling(mid));
    const report = await (await fetch(live.url + 'api/report')).json(); assert.equal(report.billing.config.mode, 'real'); assert.equal(report.summary.totalTokens, 600);
    const csv = await (await fetch(live.url + 'api/report.csv')).text(); assert.match(csv, /billing_mode/);
    const mode = (value) => fetch(live.url + 'api/billing/mode', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Origin': live.url.slice(0, -1), 'X-CostLive-Settings': '1' }, body: JSON.stringify({ mode: value, locale: 'en', subscriptions: { codex: [] } }) });
    const before = loadBilling(f.billingPath).subscriptions;
    const switched = await mode('usage'); assert.equal(switched.status, 200);
    const answer = await switched.json(); assert.equal(answer.fragment.dataset.billing.config.mode, 'usage');
    assert.deepEqual(loadBilling(f.billingPath).subscriptions, before);
    assert.equal((await mode('invalid')).status, 400);
    assert.equal((await mode('real')).status, 200);
    assert.deepEqual(loadBilling(f.billingPath).subscriptions, before);
    assert.equal((await send({ ...mid, mode: 'usage' })).status, 200);
    assert.equal((await (await fetch(live.url + 'api/report')).json()).billing.config.mode, 'usage');
  } finally { await live.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('real-price daily costs reveal seven days at a time without changing totals', () => {
  const dataset = { billing: { config: renewed(), usage: [], bounds: {} } };
  const content = { innerHTML: '' };
  const doc = { getElementById(id) { if (id === 'dsh-cost-data') return { textContent: JSON.stringify(dataset) }; if (id === 'real-pricing-content') return content; return null; }, querySelector() { return null; }, querySelectorAll() { return []; } };
  const context = vm.createContext({ window: {} }); vm.runInContext(timeRangeRuntimeSource(), context);
  const apply = (pages, range = 'all', showAllDays = false) => context.window.DSH_TIME_RANGE.applyTimeRange(doc, { range, dailyPages: pages, showAllDays, now: at('2026-11-12'), messages: MESSAGES.en });
  const count = () => (content.innerHTML.match(/<tr data-real-day>/g) || []).length;
  const initial = apply(1); assert.equal(count(), 7); assert.equal(initial.extra, 36); assert.equal(initial.allShown, false);
  assert.match(content.innerHTML, /Show more/); const cost = initial.stats.costMicroUsd;
  const next = apply(2); assert.equal(count(), 14); assert.equal(next.extra, 29); assert.equal(next.stats.costMicroUsd, cost);
  assert.match(content.innerHTML, /data-days-collapse>Show less/);
  apply(3); assert.equal(count(), 21);
  const complete = apply(7); assert.equal(count(), 43); assert.equal(complete.allShown, true);
  assert.equal(complete.stats.costMicroUsd, cost);
  assert.match(content.innerHTML, /data-days-toggle aria-expanded="true">Show less/);
  apply(1); assert.equal(count(), 7);
  const today = apply(7, 'today'); assert.equal(count(), 1); assert.equal(today.allShown, false); assert.doesNotMatch(content.innerHTML, /data-days-toggle/);
  apply(7, '7d'); assert.equal(count(), 7); assert.doesNotMatch(content.innerHTML, /data-days-toggle/);
  apply(2); assert.equal(count(), 14); apply(2); assert.equal(count(), 14);
  apply(undefined, 'all', true); assert.equal(count(), 43);
  const real = subscriptionReport([], renewed(), { now: at('2026-11-12') });
  assert.equal(real.days.length, 43);
  const html = realBody(real, 'en'); assert.equal((html.match(/<tr data-real-day>/g) || []).length, 7); assert.match(html, /data-days-toggle/); assert.doesNotMatch(html, /max-height:520px/);
  assert.doesNotMatch(realBody(subscriptionReport([], config(), { now: at('2026-11-01') }), 'en'), /data-days-toggle/);
});

test('real pricing DOM hook updates cards and providers for every range', () => {
  const nodes = new Map(); const node = () => ({ textContent: '', innerHTML: '', hidden: false, setAttribute() { }, classList: { toggle() { } } });
  const dataset = { billing: { config: renewed(), usage: [], bounds: {} } }; nodes.set('dsh-cost-data', { textContent: JSON.stringify(dataset) });
  for (const id of ['stat-cost', 'stat-cost-note', 'stat-tokens', 'stat-tokens-note', 'stat-cache-read', 'stat-cache-read-note', 'stat-token-price', 'stat-token-price-note', 'usage-pricing-content', 'real-pricing-content']) nodes.set(id, node());
  const doc = { getElementById: (id) => nodes.get(id), querySelector: () => null, querySelectorAll: () => [] };
  const context = vm.createContext({ window: {} }); vm.runInContext(timeRangeRuntimeSource(), context);
  for (const range of ['all', '30d', '7d', 'today']) {
    const result = context.window.DSH_TIME_RANGE.applyTimeRange(doc, { range, now: at('2026-11-12'), messages: MESSAGES.en });
    assert.equal(result.stats.costMicroUsd, subscriptionReport([], renewed(), { range, now: at('2026-11-12') }).summary.costMicroUsd);
    assert.match(nodes.get('real-pricing-content').innerHTML, /Costs by provider/);
    assert.doesNotMatch(nodes.get('real-pricing-content').innerHTML, /data-real-export/);
    assert.match(nodes.get('real-pricing-content').innerHTML, /<th class="num">Token<\/th>/);
  }
});
