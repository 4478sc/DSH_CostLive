import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { analyzeEvents } from '../src/engine.mjs';
import { normalizePricing } from '../src/pricing.mjs';
import { discoverSessions, matchSession, readSession } from '../src/sessions.mjs';

const PRICING = normalizePricing({ models: { 'claude-sonnet-5-5': { input: 2.3, output: 11.5, cacheWrite: 2.875, cacheRead: 0.23 } } });

function writeSession(home, id, lines) {
  const dir = join(home, 'sessions', '--F-test--', id);
  mkdirSync(dir, { recursive: true });
  const frames = lines.map((line) => zstdCompressSync(Buffer.from(`${JSON.stringify(line)}\n`)));
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames));
  return dir;
}

test('discovers a session, reads title/header, and prices its log', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cost-test-'));
  try {
    const id = 'session-test-0001';
    writeSession(home, id, [
      { type: 'session', version: 4, id, createdAt: 1792830000000, cwd: 'F:\\test', agentPreset: 'standard' },
      { type: 'model/selection', seq: 0, time: 1792830000001, data: { provider: 'aicodemirror1', model: 'claude-sonnet-5-5' } },
      { type: 'request/header', seq: 1, time: 1792830000002, data: { header: { config: { provider: 'aicodemirror1', model: 'claude-sonnet-5-5' }, tools: [] } } },
      { type: 'assistant/message', seq: 2, time: 1792830000003, data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 200 } } },
      { type: 'session/title', seq: 3, time: 1792830000004, data: { title: '测试会话' } },
    ]);
    mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true });
    writeFileSync(
      join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`),
      JSON.stringify({
        record: {
          rows: {
            title: { val: '缓存标题' },
            tokenUsage: { val: { totals: { uncachedInputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 200 }, last: null } },
          },
        },
      }),
    );

    const discovered = discoverSessions({ home });
    assert.equal(discovered.length, 1);
    const { meta, events, projection } = readSession(discovered[0]);
    assert.equal(meta.id, id);
    assert.equal(meta.title, '测试会话');
    assert.equal(meta.cwd, 'F:\\test');
    assert.equal(meta.agentPreset, 'standard');
    assert.equal(meta.createdAt, 1792830000000);
    assert.equal(projection.title, '缓存标题');

    const analysis = analyzeEvents(events, PRICING);
    assert.equal(analysis.totals.tokens.uncachedInputTokens, 1000);
    assert.equal(analysis.totals.tokens.cacheWriteTokens, 200);
    // 1000*2.3 + 100*11.5 + 200*2.875 + 500*0.23 = 2300 + 1150 + 575 + 115 = 4140 micro
    assert.equal(analysis.totals.costMicroCny, 4140);

    assert.equal(matchSession(discovered, 'session-test').session.id, id);
    assert.match(matchSession(discovered, 'nope').error, /no session/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('honors creation-time filters', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cost-test-'));
  try {
    writeSession(home, 'old', [{ type: 'session', id: 'old', createdAt: 1000, cwd: 'F:\\test' }]);
    writeSession(home, 'new', [{ type: 'session', id: 'new', createdAt: 5000, cwd: 'F:\\test' }]);
    assert.equal(discoverSessions({ home, since: 2000 }).length, 1);
    assert.equal(discoverSessions({ home, since: 2000 })[0].id, 'new');
    assert.equal(discoverSessions({ home, until: 2000 }).length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
