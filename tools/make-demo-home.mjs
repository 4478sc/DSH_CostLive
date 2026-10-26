/**
 * Build a throwaway DSH home with synthetic sessions so the dashboard can be
 * tried (and screenshotted) without any real DSH data.
 *
 *   node tools/make-demo-home.mjs [outputDir]
 *
 * The generator writes the same layout DSH uses:
 *   <home>/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd
 *   <home>/storages/session_projcache/sessions/<session-id>.json
 *
 * Every event is compressed as its own zstd frame, exactly like the
 * append-only logs produced by DSH, so the reader's multi-frame path is
 * exercised as well.
 *
 * The output is disposable: rerun the script any time, then delete the folder.
 * Timestamps are relative to "now", so the Today / 7d / 30d filters keep
 * showing a sensible split.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

const HOME = resolve(process.argv[2] ?? 'demo-home');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const DEMO_CWD = 'F:\\demo\\DSH_CostLive';
const WORKSPACE_DIR = '--F-demo-DSH_CostLive--';

/**
 * Synthetic sessions. `turns` carries one billed attempt each; a turn may
 * switch models, which is how the per-model breakdown gets exercised.
 * Costs are whatever the current price table says, not values written here.
 */
const sessions = [
  {
    id: 'demo-live-refresh',
    title: '重构实时费用面板的 20 秒刷新管线',
    createdAgo: 1.5 * HOUR,
    running: true,
    turns: [
      { provider: 'aicodemirror1', model: 'claude-sonnet-5-5', usage: { input: 24_800, output: 6_420, cacheRead: 1_860_000, cacheWrite: 96_000 } },
      { provider: 'aicodemirror1', model: 'claude-sonnet-5-5', usage: { input: 11_200, output: 3_180, cacheRead: 940_000, cacheWrite: 41_000 } },
    ],
  },
  {
    id: 'demo-peak-hours',
    title: '峰谷价格表的边界断言',
    createdAgo: 45 * 60_000,
    running: true,
    subagent: true,
    parent: 'demo-live-refresh',
    turns: [
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash', usage: { input: 78_400, output: 21_600, cacheRead: 3_200_000, cacheWrite: 210_000 } },
    ],
  },
  {
    id: 'demo-zstd-frames',
    title: '修复 zstd 多帧解压丢行',
    createdAgo: 3.2 * HOUR,
    turns: [
      { provider: 'aicodemirror1', model: 'claude-sonnet-5-5', usage: { input: 18_600, output: 8_940, cacheRead: 2_240_000, cacheWrite: 128_000 } },
    ],
  },
  {
    id: 'demo-fold-rows',
    title: '会话列表折叠到前 5 行',
    createdAgo: 1.1 * DAY,
    turns: [
      { provider: 'aicodemirror1', model: 'claude-sonnet-5-5', usage: { input: 21_500, output: 4_780, cacheRead: 1_120_000, cacheWrite: 76_000 } },
    ],
  },
  {
    id: 'demo-time-range',
    title: '时间范围筛选的边界语义',
    createdAgo: 2.3 * DAY,
    turns: [
      { provider: 'aicodemirror1', model: 'claude-sonnet-5-5', usage: { input: 32_400, output: 12_600, cacheRead: 3_480_000, cacheWrite: 188_000 } },
    ],
  },
  {
    id: 'demo-projection-parity',
    title: '与 DSH tokenUsage 投影对账',
    createdAgo: 4.6 * DAY,
    turns: [
      { provider: 'aicodemirror1', model: 'claude-sonnet-5-5', usage: { input: 9_800, output: 3_640, cacheRead: 780_000, cacheWrite: 52_000 } },
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash', usage: { input: 46_200, output: 18_900, cacheRead: 4_600_000, cacheWrite: 320_000 } },
    ],
  },
  {
    id: 'demo-health-api',
    title: '为实时页补健康检查接口',
    createdAgo: 9.4 * DAY,
    turns: [
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash', usage: { input: 38_000, output: 9_600, cacheRead: 2_100_000, cacheWrite: 145_000 } },
    ],
  },
  {
    id: 'demo-model-table',
    title: '给报告补充按模型汇总表',
    createdAgo: 18.7 * DAY,
    turns: [
      { provider: 'aicodemirror1', model: 'claude-sonnet-5-5', usage: { input: 26_900, output: 5_210, cacheRead: 1_540_000, cacheWrite: 61_000 } },
    ],
  },
  {
    id: 'demo-peak-split',
    title: '跨峰谷窗口的会话分段计价',
    createdAgo: 32.5 * DAY,
    turns: [
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash', usage: { input: 52_600, output: 14_800, cacheRead: 2_800_000, cacheWrite: 190_000 } },
    ],
  },
  {
    id: 'demo-cli-table',
    title: '初版 CLI 表格渲染',
    createdAgo: 70.2 * DAY,
    turns: [
      { provider: 'aicodemirror1', model: 'claude-sonnet-5-5', usage: { input: 14_200, output: 2_860, cacheRead: 640_000, cacheWrite: 34_000 } },
    ],
  },
  {
    id: 'demo-cross-midnight',
    title: '跨午夜会话（按天拆分）',
    crossMidnight: true,
    turns: [
      { provider: 'aicodemirror1', model: 'claude-sonnet-5-5', usage: { input: 12_400, output: 4_180, cacheRead: 1_100_000, cacheWrite: 62_000 } },
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash', usage: { input: 40_600, output: 12_300, cacheRead: 2_200_000, cacheWrite: 150_000 } },
    ],
  },
];

const logRoot = join(HOME, 'sessions', WORKSPACE_DIR);
const cacheRoot = join(HOME, 'storages', 'session_projcache', 'sessions');
rmSync(HOME, { recursive: true, force: true });
mkdirSync(logRoot, { recursive: true });
mkdirSync(cacheRoot, { recursive: true });

for (const session of sessions) {
  const createdAt =
    session.crossMidnight === true
      ? (() => {
          const midnight = new Date(NOW);
          midnight.setHours(0, 0, 0, 0);
          return midnight.getTime() - 30 * 60_000;
        })()
      : Math.round(NOW - session.createdAgo);
  const frames = [];
  let seq = 0;
  const push = (event) => {
    frames.push(zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8')));
  };

  push({
    type: 'session',
    version: 4,
    id: session.id,
    createdAt,
    cwd: DEMO_CWD,
    isSeeded: false,
    delegationDepth: session.subagent === true ? 1 : 0,
    agentPreset: 'standard',
    ...(session.subagent === true ? { origin: 'subagent', parentSession: session.parent } : {}),
  });
  push({ type: 'session/title', seq: (seq += 1), time: createdAt + 2_000, data: { title: session.title } });
  push({ type: 'sandbox/mode', seq: (seq += 1), time: createdAt + 3_000, data: { mode: 'workspace-write' } });

  session.turns.forEach((turn, index) => {
    const time =
      createdAt +
      (session.crossMidnight === true ? 10 * 60_000 + index * 40 * 60_000 : 60_000 + index * 420_000);
    push({
      type: 'request/header',
      seq: (seq += 1),
      time,
      data: { header: { config: { provider: turn.provider, model: turn.model } } },
    });
    const usage = {
      inputTokens: turn.usage.input,
      outputTokens: turn.usage.output,
      cacheReadTokens: turn.usage.cacheRead,
      cacheWriteTokens: turn.usage.cacheWrite,
      totalTokens: turn.usage.input + turn.usage.output + turn.usage.cacheRead + turn.usage.cacheWrite,
    };
    push({
      type: 'assistant/message',
      seq: (seq += 1),
      time: time + 25_000,
      data: { turn: index + 1, step: 1, usage },
    });
  });

  const sessionDir = join(logRoot, session.id);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.concat(frames));

  const rows = {
    title: { val: session.title },
    sessionStats: { val: { openStep: session.running === true ? 2 : null, turns: session.turns.length, steps: session.turns.length, pendingCalls: 0 } },
    turnBoundary: { val: { lastStepBoundary: { kind: session.running === true ? 'start' : 'end' } } },
    subagent: { val: session.subagent === true ? { identity: { mode: 'task', label: session.title, description: 'demo subagent' } } : null },
  };
  writeFileSync(
    join(cacheRoot, `${session.id}.json`),
    `${JSON.stringify({ sessionId: session.id, record: { rows } }, null, 2)}\n`,
    'utf8',
  );
}

console.log(`demo home: ${HOME}`);
console.log(`sessions : ${sessions.length} (${sessions.filter((s) => s.running === true).length} running)`);
console.log(`try      : node bin/dsh-cost-live.mjs --home "${HOME}"`);