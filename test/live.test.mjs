import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import {
  collectLiveReport,
  renderLiveDocument,
  renderLiveFragment,
  splitReportHtml,
  writeLiveSnapshot,
} from '../src/live.mjs';
import { renderHtml } from '../src/report-html.mjs';
import { startLiveServer } from '../src/live-server.mjs';

function writeSession(home, id, lines) {
  const dir = join(home, 'sessions', '--F-test--', id);
  mkdirSync(dir, { recursive: true });
  const frames = lines.map((line) => zstdCompressSync(Buffer.from(`${JSON.stringify(line)}\n`)));
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames));
}

/** Two priced/unpriced sessions plus one with no usage at all. */
function createHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cost-live-test-'));
  writeSession(home, 'session-live-0001', [
    { type: 'session', version: 4, id: 'session-live-0001', createdAt: 1792830000000, cwd: 'F:\\test', agentPreset: 'standard' },
    { type: 'model/selection', seq: 0, time: 1792830000001, data: { provider: 'aicodemirror1', model: 'claude-sonnet-5-5' } },
    {
      type: 'assistant/message',
      seq: 1,
      time: 1792830000002,
      data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 200 } },
    },
    { type: 'session/title', seq: 2, time: 1792830000003, data: { title: '实时测试会话' } },
  ]);
  writeSession(home, 'session-live-0002', [
    { type: 'session', version: 4, id: 'session-live-0002', createdAt: 1792830001000, cwd: 'F:\\test' },
    { type: 'model/selection', seq: 0, time: 1792830001001, data: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } },
    {
      type: 'assistant/message',
      seq: 1,
      time: 1792830001002,
      data: { turn: 1, step: 1, usage: { inputTokens: 2000, outputTokens: 300 } },
    },
  ]);
  writeSession(home, 'session-live-0003', [
    { type: 'session', version: 4, id: 'session-live-0003', createdAt: 1792830002000, cwd: 'F:\\test' },
    { type: 'session/title', seq: 0, time: 1792830002001, data: { title: '空会话' } },
  ]);
  return home;
}

test('collectLiveReport mirrors CLI filters, pricing, and empty-session handling', () => {
  const home = createHome();
  try {
    const report = collectLiveReport({ home });
    assert.equal(report.summary.sessions, 2);
    // session-live-0002 runs DeepSeek V4.1 Flash at 05:40 UTC on a Saturday, so
    // it bills at the 谷值 rate: 2000×0.15 + 300×0.6 = 480 micro-CNY on top of
    // sonnet's 4140.
    assert.equal(report.summary.pricedSessions, 2);
    assert.equal(report.summary.costMicroCny, 4620);
    assert.equal(report.summary.costCny, 0.00462);
    assert.deepEqual(report.summary.unpricedModels, []);
    assert.deepEqual(
      report.sessions.map((session) => session.id),
      ['session-live-0001', 'session-live-0002'],
    );

    const sonnetOnly = collectLiveReport({ home, model: 'sonnet' });
    assert.equal(sonnetOnly.summary.sessions, 1);
    assert.equal(sonnetOnly.sessions[0].title, '实时测试会话');

    const pricedOnly = collectLiveReport({ home, pricedOnly: true });
    assert.equal(pricedOnly.summary.sessions, 2);

    const all = collectLiveReport({ home, includeEmpty: true });
    assert.equal(all.summary.sessions, 3);

    const topOne = collectLiveReport({ home, top: 1 });
    assert.equal(topOne.sessions.length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('splitReportHtml keeps the original report styles and wrap markup', () => {
  const home = createHome();
  try {
    const report = collectLiveReport({ home });
    const { styles, body } = splitReportHtml(renderHtml(report));
    assert.match(styles, /--accent: #0f766e/u);
    assert.ok(body.startsWith('<div class="wrap">'));
    assert.ok(body.endsWith('</div>'));
    assert.match(body, /实时测试会话/u);
    assert.match(body, /session-live-0001/u);
    assert.doesNotMatch(body, /<script>/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('renderLiveDocument embeds mode/interval config and the live client', () => {
  const home = createHome();
  try {
    const report = collectLiveReport({ home });
    const filePage = renderLiveDocument({
      report,
      mode: 'file',
      intervalMs: 20_000,
      autoReload: true,
      serverUrl: 'http://127.0.0.1:4173/',
    });
    assert.match(filePage, /<div class="wrap" id="live-wrap">/u);
    assert.match(filePage, /"mode":"file"/u);
    assert.match(filePage, /"autoReload":true/u);
    assert.match(filePage, /"intervalMs":20000/u);
    assert.match(filePage, /http:\/\/127\.0\.0\.1:4173\//u);
    assert.match(filePage, /dsh-cost-live:v1/u);
    // The static report's per-row listener must not be embedded (the live client delegates).
    assert.doesNotMatch(filePage, /querySelectorAll\('tr\.session'\)\.forEach/u);

    const httpPage = renderLiveDocument({ report, mode: 'http', intervalMs: 10_000 });
    assert.match(httpPage, /"mode":"http"/u);
    assert.match(httpPage, /"autoReload":false/u);
    assert.match(httpPage, /\/api\/fragment/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('renderLiveFragment returns markup that can replace the wrap', () => {
  const home = createHome();
  try {
    const report = collectLiveReport({ home });
    const fragment = renderLiveFragment(report);
    assert.equal(fragment.generatedAt, report.generatedAt);
    assert.equal(fragment.summary.sessions, 2);
    assert.ok(fragment.html.startsWith('<div class="wrap">'));
    assert.match(fragment.html, /实时测试会话/u);
    // The swapped body carries both the range selector and the dataset, so the
    // client can re-apply the active range without a second request.
    assert.match(fragment.html, /id="dsh-cost-range"/u);
    assert.match(fragment.html, /id="dsh-cost-data"/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeLiveSnapshot writes atomically and leaves no temp file', () => {
  const home = createHome();
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-cost-live-out-'));
  try {
    const report = collectLiveReport({ home });
    const outPath = join(outDir, 'dsh-cost-live.html');
    const written = writeLiveSnapshot({ outPath, report, mode: 'file', intervalMs: 20_000, autoReload: true });
    assert.equal(written, outPath);
    assert.ok(existsSync(outPath));
    const html = readFileSync(outPath, 'utf8');
    assert.match(html, /实时测试会话/u);
    assert.match(html, /"autoReload":true/u);
    assert.deepEqual(readdirSync(outDir), ['dsh-cost-live.html']);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('live server serves the page, fragment, report, and health endpoints', async () => {
  const home = createHome();
  const logger = { log() {}, warn() {} };
  let live = null;
  try {
    live = await startLiveServer({
      host: '127.0.0.1',
      port: 0,
      intervalMs: 20_000,
      reportOptions: { home },
      open: false,
      logger,
    });
    assert.equal(live.port > 0, true);

    const pageResponse = await fetch(live.url);
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.text();
    assert.match(page, /<div class="wrap" id="live-wrap">/u);
    assert.match(page, /"mode":"http"/u);
    assert.match(page, /实时测试会话/u);

    const fragmentResponse = await fetch(`${live.url}api/fragment`);
    assert.equal(fragmentResponse.status, 200);
    const fragment = await fragmentResponse.json();
    assert.equal(fragment.summary.sessions, 2);
    assert.equal(fragment.summary.costMicroCny, undefined);
    assert.equal(fragment.summary.costCny, 0.00462);
    assert.equal(fragment.intervalMs, 20_000);
    assert.equal(fragment.stale, false);
    assert.match(fragment.html, /实时测试会话/u);

    const reportResponse = await fetch(`${live.url}api/report`);
    assert.equal(reportResponse.status, 200);
    const report = await reportResponse.json();
    assert.equal(report.tool, 'dsh-cost');
    assert.equal(report.summary.sessions, 2);
    assert.equal(report.sessions.length, 2);
    assert.equal(report.live.stale, false);

    const healthResponse = await fetch(`${live.url}api/health`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.ok, true);
    assert.equal(health.tool, 'dsh-cost-live');
    assert.equal(health.sessions, 2);
    assert.ok(health.scans >= 1);

    const missingResponse = await fetch(`${live.url}missing`);
    assert.equal(missingResponse.status, 404);
  } finally {
    if (live) await live.close();
    rmSync(home, { recursive: true, force: true });
  }
});
