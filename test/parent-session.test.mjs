/**
 * Parent-session names in the live/report UI.
 *
 * A subagent's header names its direct parent by id (`session-<uuid>`), but the
 * UI has to show the parent's *name* (its title). The parent may be outside the
 * active date/model filter or the current page, so names are resolved against
 * the complete session set of the same source. Fixtures below are synthetic:
 * ids collide on purpose to prove sources are isolated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { collectLiveReport } from '../src/live.mjs';
import { canonicalSessionId, parentSessionIdOf, resolveSessionParents } from '../src/lineage.mjs';
import { buildReportDataset, renderHtml } from '../src/report-html.mjs';

/** Write one session log; `dirId` and header id differ exactly as in DSH. */
function writeSession(home, { dirId, header, events = [] }) {
  const dir = join(home, 'sessions', '--F-test--', dirId);
  mkdirSync(dir, { recursive: true });
  const lines = [header, ...events];
  const frames = lines.map((line) => zstdCompressSync(Buffer.from(`${JSON.stringify(line)}\n`)));
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames));
}

const header = (id, extra = {}) => ({ type: 'session', version: 4, id, createdAt: 1792830000000, cwd: 'F:\\test', agentPreset: 'standard', ...extra });

/** A text usage sample so the session survives the "has samples" filter. */
const usage = (seq, time = 1792830001000) => [
  { type: 'model/selection', seq, time, data: { provider: 'aicodemirror1', model: 'claude-sonnet-5-5' } },
  { type: 'assistant/message', seq: seq + 1, time: time + 1, data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 100 } } },
];

const title = (seq, text, time = 1792830002000) => ({ type: 'session/title', seq, time, data: { title: text } });

const subHeader = (id, parentSession, extra = {}) =>
  header(id, { parentSession, origin: 'subagent', delegationDepth: 1, ...extra });

/** Home with a named parent, a main session, and three children (ok/missing/untitled). */
function createHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cost-parent-'));
  writeSession(home, { dirId: 'session-p-0001', header: header('p-0001'), events: [title(0, '父会话Alpha')] });
  writeSession(home, { dirId: 'session-m-0001', header: header('m-0001'), events: [...usage(0), title(2, '主会话Beta')] });
  writeSession(home, {
    dirId: 'session-c-0001',
    header: subHeader('c-0001', 'session-p-0001'),
    events: [...usage(0), title(2, '子代理会话子项')],
  });
  writeSession(home, {
    dirId: 'session-c-0002',
    header: subHeader('c-0002', 'session-ghost-9999'),
    events: [...usage(0), title(2, '孤立子代理')],
  });
  writeSession(home, { dirId: 'session-p-0002', header: header('p-0002') });
  writeSession(home, {
    dirId: 'session-c-0003',
    header: subHeader('c-0003', 'session-p-0002'),
    events: [...usage(0), title(2, '无题父代理子会话')],
  });
  return home;
}

const BASE = { billingDocument: { mode: 'usage' }, official: false };

/** One `<tr class="session">…</tr>` block whose title matches. */
function sessionRow(html, text) {
  const rows = html.match(/<tr class="session[\s\S]*?<\/tr>/gu) ?? [];
  return rows.find((row) => row.includes(text)) ?? '';
}

/** The expanded detail block that belongs to one session row. */
function detailBlock(html, row) {
  const target = /data-target="([^"]+)"/u.exec(row)?.[1] ?? '';
  const start = html.indexOf('<tr class="detail" id="' + target + '"');
  return start === -1 ? '' : html.slice(start, html.indexOf('</tr>', start) + 5);
}

/** One plain `<tr>…</tr>` block (the daily mini table) whose title matches. */
function dailyRow(section, text) {
  const rows = section.match(/<tr>[\s\S]*?<\/tr>/gu) ?? [];
  return rows.find((row) => row.includes(text)) ?? '';
}

test('canonical ids accept both session- spellings and reject empties', () => {
  assert.equal(canonicalSessionId('session-abc'), 'abc');
  assert.equal(canonicalSessionId('abc'), 'abc');
  assert.equal(canonicalSessionId('  session-abc  '), 'abc');
  assert.equal(canonicalSessionId(''), null);
  assert.equal(canonicalSessionId('session-'), null);
  assert.equal(canonicalSessionId(null), null);
  assert.equal(parentSessionIdOf({ parentSession: 'session-p-0001' }), 'p-0001');
  assert.equal(parentSessionIdOf({ parentSession: null }), null);
  assert.equal(parentSessionIdOf({}), null);
});

test('resolveSessionParents prefers the parsed scan and resolves the rest from the same source', () => {
  const home = createHome();
  try {
    const sources = [{ label: 'host', home }];
    // Parent present in this scan: its already-parsed title is reused.
    const parentMeta = { id: 'p-0001', dirName: 'session-p-0001', title: '父会话Alpha', source: 'host', sourceHome: home };
    // Parent outside the result set (e.g. filtered by date): read from disk.
    const childMeta = { id: 'c-0001', parentSession: 'session-p-0001', origin: 'subagent', source: 'host', sourceHome: home };
    const ghostMeta = { id: 'c-0002', parentSession: 'session-ghost-9999', origin: 'subagent', source: 'host', sourceHome: home };
    const untitledMeta = { id: 'c-0003', parentSession: 'session-p-0002', origin: 'subagent', source: 'host', sourceHome: home };
    const mainMeta = { id: 'm-0001', source: 'host', sourceHome: home };
    const parents = resolveSessionParents({
      results: [{ meta: parentMeta }, { meta: childMeta }, { meta: ghostMeta }, { meta: untitledMeta }, { meta: mainMeta }],
      sources,
    });
    assert.equal(parents.has(mainMeta), false);
    assert.deepEqual(parents.get(childMeta), { parentSessionId: 'p-0001', parentTitle: '父会话Alpha', parentFound: true });
    assert.deepEqual(parents.get(ghostMeta), { parentSessionId: 'ghost-9999', parentTitle: null, parentFound: false });
    // The parent exists but has no title: found, still no name to show.
    assert.deepEqual(parents.get(untitledMeta), { parentSessionId: 'p-0002', parentTitle: null, parentFound: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a parent outside the active date filter still provides its name', () => {
  const home = createHome();
  try {
    // The parent was created one day earlier than the child, so `since` keeps
    // only the child in the result set.
    const since = new Date(1792825000000).toISOString();
    const report = collectLiveReport({ ...BASE, home, since });
    // The parent is too old for this window, so its own row cannot be the
    // source of the name: the name came from the complete session set.
    assert.equal(report.sessions.some((session) => session.id === 'p-0001'), false);
    const child = report.sessions.find((session) => session.id === 'c-0001');
    assert.equal(child.isSubagent, true);
    assert.equal(child.parentTitle, '父会话Alpha');
    assert.equal(child.parentFound, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('parents are resolved per source, so colliding ids never cross homes', () => {
  const homeA = mkdtempSync(join(tmpdir(), 'dsh-cost-parent-a-'));
  const homeB = mkdtempSync(join(tmpdir(), 'dsh-cost-parent-b-'));
  try {
    writeSession(homeA, { dirId: 'session-shared-0001', header: header('shared-0001'), events: [title(0, 'A的父会话')] });
    writeSession(homeB, { dirId: 'session-shared-0001', header: header('shared-0001'), events: [title(0, 'B的父会话')] });
    writeSession(homeA, {
      dirId: 'session-c-0001',
      header: subHeader('c-0001', 'session-shared-0001'),
      events: [...usage(0), title(2, 'A源子代理')],
    });
    const report = collectLiveReport({ ...BASE, sources: [`host=${homeA}`, `vm=${homeB}`] });
    const child = report.sessions.find((session) => session.id === 'c-0001');
    assert.equal(child.source, 'host');
    assert.equal(child.parentTitle, 'A的父会话');
    assert.equal(child.parentTitle === 'B的父会话', false);
  } finally {
    rmSync(homeA, { recursive: true, force: true });
    rmSync(homeB, { recursive: true, force: true });
  }
});

test('session view marks the role and names the direct parent, with a localized fallback', () => {
  const home = createHome();
  try {
    const report = collectLiveReport({ ...BASE, home });
    const html = renderHtml(report);
    const main = sessionRow(html, '主会话Beta');
    assert.match(main, /class="pill pill-main">主会话</u);
    assert.doesNotMatch(main, /parent-line/u);

    const child = sessionRow(html, '子代理会话子项');
    assert.match(child, /class="pill pill-sub">子代理</u);
    assert.match(child, /class="parent-name">父会话Alpha</u);
    assert.match(child, /父会话：/u);
    // The parent's session id is not used as its name.
    assert.doesNotMatch(child, />session-p-0001</u);

    const ghost = sessionRow(html, '孤立子代理');
    assert.match(ghost, /父会话名称不可用/u);
    assert.doesNotMatch(ghost, /session-ghost-9999/u);

    const untitled = sessionRow(html, '无题父代理子会话');
    assert.match(untitled, /父会话名称不可用/u);

    // The expanded detail repeats the role and the parent name, and a main
    // session's detail has no parent line at all.
    const childDetail = detailBlock(html, child);
    assert.match(childDetail, /角色 子代理/u);
    assert.match(childDetail, /父会话 <span class="parent-name">父会话Alpha/u);
    const mainDetail = detailBlock(html, main);
    assert.match(mainDetail, /角色 主会话/u);
    assert.doesNotMatch(mainDetail, /父会话/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('daily view marks the role and names the parent of a subagent row', () => {
  const home = createHome();
  try {
    const report = collectLiveReport({ ...BASE, home });
    const html = renderHtml(report);
    const daily = html.slice(html.indexOf('<section id="daily"'), html.indexOf('</section>', html.indexOf('<section id="daily"')));
    assert.ok(daily.length > 0);
    assert.match(daily, /class="pill pill-main">主会话</u);
    const childRow = dailyRow(daily, '子代理会话子项');
    assert.match(childRow, /class="pill pill-sub">子代理</u);
    assert.match(childRow, /class="parent-name">父会话Alpha</u);
    const mainRow = dailyRow(daily, '主会话Beta');
    assert.match(mainRow, /class="pill pill-main">主会话</u);
    assert.doesNotMatch(mainRow, /parent-line/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});


test('a nested subagent names its direct parent, not the root session', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cost-parent-nested-'));
  try {
    writeSession(home, { dirId: 'session-root-0001', header: header('root-0001'), events: [title(0, '根会话')] });
    writeSession(home, {
      dirId: 'session-mid-0001',
      header: subHeader('mid-0001', 'session-root-0001', { delegationDepth: 1 }),
      events: [title(0, '中间层父代理')],
    });
    writeSession(home, {
      dirId: 'session-leaf-0001',
      header: subHeader('leaf-0001', 'session-mid-0001', { delegationDepth: 2 }),
      events: [...usage(0), title(2, '叶子子代理')],
    });
    const report = collectLiveReport({ ...BASE, home });
    const leaf = report.sessions.find((session) => session.id === 'leaf-0001');
    assert.equal(leaf.parentTitle, '中间层父代理');
    assert.equal(leaf.parentTitle === '根会话', false);
    // The direct parent is not in the result set (no usage), which also proves
    // the name does not come from a parent row.
    assert.equal(report.sessions.some((session) => session.id === 'mid-0001'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test('a hostile parent title is escaped in both views', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cost-parent-xss-'));
  try {
    writeSession(home, {
      dirId: 'session-p-0001',
      header: header('p-0001'),
      events: [title(0, '<img src=x onerror="alert(1)">')],
    });
    writeSession(home, {
      dirId: 'session-c-0001',
      header: subHeader('c-0001', 'session-p-0001'),
      events: [...usage(0), title(2, '转义测试子会话')],
    });
    const report = collectLiveReport({ ...BASE, home });
    assert.equal(report.sessions[0].parentTitle, '<img src=x onerror="alert(1)">');
    const html = renderHtml(report);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/u);
    assert.equal(html.includes('<img src=x onerror="alert(1)">'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('English locale localizes the role and the parent placeholder', () => {
  const home = createHome();
  try {
    const report = collectLiveReport({ ...BASE, home });
    const html = renderHtml(report, { locale: 'en' });
    assert.match(html, /class="pill pill-main">main session</u);
    assert.match(html, /parent session: <span class="parent-name">父会话Alpha</u);
    assert.match(html, /parent session name unavailable/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the live dataset carries the parent name for session and day rows', () => {
  const home = createHome();
  try {
    const report = collectLiveReport({ ...BASE, home });
    const dataset = buildReportDataset(report);
    const child = dataset.sessions.find((session) => session.id === 'c-0001');
    assert.equal(child.isSubagent, true);
    assert.equal(child.parentTitle, '父会话Alpha');
    assert.equal(child.parentFound, true);
    const main = dataset.sessions.find((session) => session.id === 'm-0001');
    assert.equal(main.parentTitle, null);
    const dayChild = dataset.days.flatMap((day) => day.sessions).find((session) => session.id === 'c-0001');
    assert.equal(dayChild.parentTitle, '父会话Alpha');
    assert.equal(dayChild.isSubagent, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
