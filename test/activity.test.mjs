import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import {
  ACTIVITY_COMPLETED,
  ACTIVITY_RUNNING_MAIN,
  ACTIVITY_RUNNING_SUBAGENT,
  activityRank,
  compareSessionRecords,
  isSubagentSession,
  projectionIsRunning,
} from '../src/activity.mjs';
import { main } from '../src/cli.mjs';
import { collectLiveReport, renderLiveDocument, renderLiveFragment } from '../src/live.mjs';
import { renderHtml } from '../src/report-html.mjs';

const BASE_TIME = 1792830000000;

/** Session fixtures: two running sessions, then six completed ones by cost. */
const FIXTURES = [
  { id: 'session-order-run-main', title: '运行中主会话', input: 100, running: true, subagent: false },
  { id: 'session-order-run-sub', title: '运行中子代理', input: 50, running: true, subagent: true },
  { id: 'session-order-done-big', title: '已完成高费用', input: 1_000_000, running: false, subagent: false },
  { id: 'session-order-done-3', title: '已完成 3', input: 5_000, running: false, subagent: false },
  { id: 'session-order-done-4', title: '已完成 4', input: 4_000, running: false, subagent: false },
  { id: 'session-order-done-5', title: '已完成 5', input: 3_000, running: false, subagent: false },
  { id: 'session-order-done-6', title: '已完成 6', input: 2_000, running: false, subagent: false },
  { id: 'session-order-done-sub', title: '已完成子代理', input: 1_000, running: false, subagent: true },
];
const EXPECTED_IDS = FIXTURES.map((fixture) => fixture.id);
const EXPECTED_TITLES = FIXTURES.map((fixture) => fixture.title);

function writeSession(home, fixture, index) {
  const dir = join(home, 'sessions', '--F-order-test--', fixture.id);
  mkdirSync(dir, { recursive: true });
  const header = {
    type: 'session',
    version: 4,
    id: fixture.id,
    createdAt: BASE_TIME + index * 1000,
    cwd: 'F:\\test',
    agentPreset: 'standard',
  };
  if (fixture.subagent) {
    header.origin = 'subagent';
    header.parentSession = 'session-order-run-main';
    header.delegationDepth = 1;
  }
  const lines = [
    header,
    {
      type: 'model/selection',
      seq: 0,
      time: BASE_TIME + index * 1000 + 1,
      data: { provider: 'aicodemirror1', model: 'claude-sonnet-5-5' },
    },
    {
      type: 'assistant/message',
      seq: 1,
      time: BASE_TIME + index * 1000 + 2,
      data: { turn: 1, step: 1, usage: { inputTokens: fixture.input, outputTokens: 10 } },
    },
    { type: 'session/title', seq: 2, time: BASE_TIME + index * 1000 + 3, data: { title: fixture.title } },
  ];
  writeFileSync(
    join(dir, 'session.v4.jsonl.zstd'),
    Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(`${JSON.stringify(line)}\n`)))),
  );

  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, `${fixture.id}.json`),
    JSON.stringify({
      version: 7,
      record: {
        rows: {
          sessionStats: { val: { openStep: fixture.running ? { turn: 1, step: 2 } : null } },
          subagent: { val: fixture.subagent ? { identity: { mode: 'continuable', label: fixture.title } } : {} },
        },
      },
    }),
  );
}

function createHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cost-activity-test-'));
  FIXTURES.forEach((fixture, index) => writeSession(home, fixture, index));
  return home;
}

function assertTitleOrder(html) {
  const positions = EXPECTED_TITLES.map((title) => html.indexOf(title));
  assert.ok(positions.every((position) => position !== -1), 'every session title should be rendered');
  const sorted = [...positions].sort((a, b) => a - b);
  assert.deepEqual(positions, sorted, 'HTML title order should follow the activity sort');
}

test('projection openStep marks running, with turnBoundary as fallback', () => {
  assert.equal(projectionIsRunning(null), false);
  assert.equal(projectionIsRunning(undefined), false);
  assert.equal(projectionIsRunning({ sessionStats: { openStep: null } }), false);
  assert.equal(projectionIsRunning({ sessionStats: { openStep: { turn: 1, step: 2 } } }), true);
  assert.equal(
    projectionIsRunning({ sessionStats: null, turnBoundary: { lastStepBoundary: { kind: 'start' } } }),
    true,
  );
  assert.equal(
    projectionIsRunning({ sessionStats: {}, turnBoundary: { lastStepBoundary: { kind: 'start' } } }),
    true,
  );
  assert.equal(
    projectionIsRunning({ sessionStats: { openStep: null }, turnBoundary: { lastStepBoundary: { kind: 'start' } } }),
    false,
  );
  assert.equal(
    projectionIsRunning({ sessionStats: null, turnBoundary: { lastStepBoundary: { kind: 'end' } } }),
    false,
  );
});

test('subagent detection prefers projection identity and falls back to log origin', () => {
  assert.equal(isSubagentSession({ origin: null }, null), false);
  assert.equal(isSubagentSession({ origin: 'subagent' }, null), true);
  assert.equal(isSubagentSession({ origin: null }, { subagent: { identity: { mode: 'continuable' } } }), true);
  assert.equal(isSubagentSession({ origin: 'subagent' }, { subagent: {} }), true);
});

test('activity rank and record comparator put running main before subagent before completed', () => {
  assert.equal(activityRank({ running: true, isSubagent: false }), ACTIVITY_RUNNING_MAIN);
  assert.equal(activityRank({ running: true, isSubagent: true }), ACTIVITY_RUNNING_SUBAGENT);
  assert.equal(activityRank({ running: false, isSubagent: false }), ACTIVITY_COMPLETED);
  assert.equal(activityRank({ running: false, isSubagent: true }), ACTIVITY_COMPLETED);

  const records = [
    { id: 'done-cheap', running: false, isSubagent: false, totals: { costMicroCny: 10 }, createdAt: 1 },
    { id: 'done-sub', running: false, isSubagent: true, totals: { costMicroCny: 500 }, createdAt: 1 },
    { id: 'run-sub', running: true, isSubagent: true, totals: { costMicroCny: 1 }, createdAt: 1 },
    { id: 'done-rich', running: false, isSubagent: false, totals: { costMicroCny: 900 }, createdAt: 1 },
    { id: 'run-main', running: true, isSubagent: false, totals: { costMicroCny: 1 }, createdAt: 1 },
  ];
  assert.deepEqual(
    records.slice().sort(compareSessionRecords).map((record) => record.id),
    ['run-main', 'run-sub', 'done-rich', 'done-sub', 'done-cheap'],
  );
});

test('live report sorts running sessions first and keeps activity fields in JSON records', () => {
  const home = createHome();
  try {
    const report = collectLiveReport({ home });
    assert.deepEqual(
      report.sessions.map((session) => session.id),
      EXPECTED_IDS,
    );
    assert.deepEqual(
      report.sessions.map((session) => session.running),
      [true, true, false, false, false, false, false, false],
    );
    assert.deepEqual(
      report.sessions.map((session) => session.isSubagent),
      [false, true, false, false, false, false, false, true],
    );
    assert.equal(report.sessions[0].origin, null);
    assert.equal(report.sessions[1].origin, 'subagent');
    assert.equal(report.sessions[1].parentSession, 'session-order-run-main');
    // Completed sessions keep the cost order.
    assert.deepEqual(
      report.sessions.slice(2).map((session) => session.id),
      ['session-order-done-big', 'session-order-done-3', 'session-order-done-4', 'session-order-done-5', 'session-order-done-6', 'session-order-done-sub'],
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('HTML renders running badges, hides sessions after the first five, and orders rows', () => {
  const home = createHome();
  try {
    const report = collectLiveReport({ home });
    const html = renderHtml(report);
    assertTitleOrder(html);

    const sessionTags = [...html.matchAll(/<tr class="session[^"]*"[^>]*>/gu)].map((match) => match[0]);
    assert.equal(sessionTags.length, EXPECTED_IDS.length);
    assert.equal(sessionTags.filter((tag) => / hidden\b/u.test(tag)).length, EXPECTED_IDS.length - 5);
    assert.ok(sessionTags.slice(0, 5).every((tag) => !/ hidden\b/u.test(tag)));
    assert.match(sessionTags[0], /is-running/u);
    assert.match(sessionTags[1], /is-subagent/u);
    assert.match(sessionTags[1], /data-running="true"/u);

    assert.match(html, /class="pill pill-run"/u);
    assert.match(html, /class="pill pill-sub"/u);
    assert.match(html, /data-sessions-toggle/u);
    assert.match(html, /显示更多（还有 3 个）/u);
    assert.match(html, /tr.session-extra\[hidden\]/u);
    assert.match(html, /运行中（主会话）/u);
    assert.match(html, /运行中（子代理）/u);

    // Five or fewer sessions: the paging control disappears and nothing is hidden.
    const small = renderHtml({ ...report, sessions: report.sessions.slice(0, 3) });
    assert.doesNotMatch(small, /<button[^>]*data-sessions-toggle/u);
    assert.doesNotMatch(small, /class="[^"]*session-extra/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('live fragment/document keep the order, paging control, and state restoration', () => {
  const home = createHome();
  try {
    const report = collectLiveReport({ home });
    const fragment = renderLiveFragment(report);
    assert.ok(fragment.html.startsWith('<div class="wrap">'));
    assertTitleOrder(fragment.html);
    assert.match(fragment.html, /data-sessions-toggle/u);
    assert.equal((fragment.html.match(/data-sessions-toggle/gu) ?? []).length, 1);

    const page = renderLiveDocument({ report, mode: 'http' });
    assert.match(page, /data-sessions-toggle/u);
    // The range/paging runtime is injected by live.mjs (same source the static
    // report embeds) and the client re-applies it after every fragment swap.
    assert.match(page, /window\.DSH_TIME_RANGE/u);
    assert.match(page, /function applyTimeRange/u);
    assert.match(page, /dsh-cost-range/u);
    assert.match(page, /showAll/u);
    assert.match(page, /session-extra/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** Run the CLI in-process (spawning Node with piped stdio is blocked by the sandbox). */
function runCli(args) {
  const stdout = [];
  const stderr = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = (chunk) => {
    stdout.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  try {
    const code = main(args);
    return { code, stdout: stdout.join(''), stderr: stderr.join('') };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

test('CLI JSON and table list use the same running-first order', () => {
  const home = createHome();
  try {
    const jsonRun = runCli(['--home', home, '--format', 'json']);
    assert.equal(jsonRun.code, 0, jsonRun.stderr);
    const cliReport = JSON.parse(jsonRun.stdout);
    assert.deepEqual(
      cliReport.sessions.map((session) => session.id),
      EXPECTED_IDS,
    );
    assert.deepEqual(
      cliReport.sessions.map((session) => session.running),
      [true, true, false, false, false, false, false, false],
    );

    const listRun = runCli(['--home', home]);
    assert.equal(listRun.code, 0, listRun.stderr);
    assert.match(listRun.stdout, /运行中 2 个已置顶/u);
    assert.ok(listRun.stdout.indexOf('运行中主会话') < listRun.stdout.indexOf('已完成高费用'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
