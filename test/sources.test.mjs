import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { collectLiveReport } from '../src/live.mjs';
import { renderHtml } from '../src/report-html.mjs';
import { loadSources } from '../src/sources.mjs';

function writeSession(home, id, costTokens = 1000) {
  const dir = join(home, 'sessions', '--F-test--', id);
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'session', version: 4, id, createdAt: 1792830000000, cwd: 'F:\\test', agentPreset: 'standard' },
    { type: 'model/selection', seq: 0, time: 1792830000001, data: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } },
    {
      type: 'assistant/message',
      seq: 1,
      time: 1792830000002,
      data: { turn: 1, step: 1, usage: { inputTokens: costTokens, outputTokens: 100, cacheReadTokens: 500 } },
    },
  ];
  const frames = lines.map((line) => zstdCompressSync(Buffer.from(`${JSON.stringify(line)}\n`)));
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames));
  return home;
}

function createHome(prefix, ids) {
  const home = mkdtempSync(join(tmpdir(), `dsh-cost-${prefix}-`));
  for (const id of ids) writeSession(home, id);
  return home;
}

test('loadSources resolves JSON relative paths, ~, CLI specs, and duplicate labels', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-cost-sources-'));
  try {
    mkdirSync(join(base, 'nested'));
    writeFileSync(
      join(base, 'nested', 'sources.json'),
      JSON.stringify({ sources: [{ label: 'rel', home: '../mirror' }] }),
    );
    const sources = loadSources({
      sourcesPath: join(base, 'nested', 'sources.json'),
      sources: ['extra=./somewhere', 'dup=~/a', 'dup=~/b'],
      home: 'C:\\fallback',
    });
    assert.deepEqual(sources.map((source) => source.label), ['rel', 'extra', 'dup', 'dup#2']);
    assert.equal(sources[0].home, join(base, 'mirror'));
    assert.ok(sources[1].home.endsWith('somewhere'));
    assert.ok(sources[2].home.length > 0);

    const fallback = loadSources({ home: 'C:\\only-home' });
    assert.deepEqual(fallback, [{ label: 'local', home: 'C:\\only-home' }]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('collectLiveReport merges multiple homes and tracks per-source counts', () => {
  const host = createHome('host', ['session-host-1', 'session-host-2']);
  const vm = createHome('vm', ['session-vm-1']);
  try {
    const report = collectLiveReport({
      sources: [`host=${host}`, `vm=${vm}`],
      includeEmpty: true,
    });
    assert.equal(report.summary.sessions, 3);
    assert.equal(report.sessions.filter((session) => session.source === 'host').length, 2);
    assert.equal(report.sessions.filter((session) => session.source === 'vm').length, 1);
    assert.equal(report.sources.length, 2);
    assert.equal(report.sources[0].sessions, 2);
    assert.equal(report.sources[1].sessions, 1);
    assert.ok(report.sessions.every((session) => typeof session.uid === 'string' && session.uid.includes(':')));

    const html = renderHtml(report);
    assert.match(html, /chip-source/u);
    assert.match(html, />host</u);
    assert.match(html, />vm</u);
    assert.match(html, /数据源/u);
  } finally {
    rmSync(host, { recursive: true, force: true });
    rmSync(vm, { recursive: true, force: true });
  }
});

test('a missing source is reported without hiding the remaining source', () => {
  const host = createHome('solo', ['session-solo-1']);
  const missing = join(tmpdir(), `dsh-cost-missing-${process.pid}-${Date.now()}`);
  try {
    const warnings = [];
    const report = collectLiveReport({
      sources: [`host=${host}`, `vm=${missing}`],
      includeEmpty: true,
      onWarning: (message) => warnings.push(message),
    });
    assert.equal(report.summary.sessions, 1);
    const vm = report.sources.find((source) => source.label === 'vm');
    assert.ok(vm.error);
    assert.equal(vm.sessions, 0);
    assert.ok(warnings.some((message) => message.includes('vm')));
    assert.match(renderHtml(report), /数据源不可用/u);
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});