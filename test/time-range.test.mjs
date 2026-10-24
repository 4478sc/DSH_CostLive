import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { DEFAULT_PRICING, formatCny, formatTokens, normalizePricing } from '../src/pricing.mjs';
import { buildTimeRangeDataset } from '../src/report-data.mjs';
import { renderHtml } from '../src/report-html.mjs';
import {
  DAY_MS,
  TIME_RANGES,
  TIME_RANGE_STORAGE_KEY,
  aggregateRangeStats,
  filterSessionsByRange,
  formatDay,
  formatRangeLabel,
  localMidnight,
  normalizeTimeRange,
  rangeCutoff,
  sessionMatchesRange,
  timeRangeRuntimeSource,
  zeroTokens,
} from '../src/time-range.mjs';

/** Fixed "now": 2026-10-24 21:09:20 in the test machine's local time zone. */
const NOW = new Date(2026, 9, 24, 21, 9, 20).getTime();
const TODAY = new Date(2026, 9, 24).getTime();

/** Token buckets with the derived total the report uses. */
function bucket(uncachedInputTokens, outputTokens, cacheWriteTokens, cacheReadTokens) {
  return {
    uncachedInputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    totalTokens: uncachedInputTokens + outputTokens + cacheWriteTokens + cacheReadTokens,
  };
}

/** Flattened (browser-dataset) session record. */
function datasetRecord(id, createdAt, options = {}) {
  const tokens = options.tokens ?? bucket(1000, 100, 0, 9000);
  const models = options.models ?? [
    { provider: 'p', model: 'm1', priced: true, costMicroCny: options.costMicroCny ?? 1000, cacheSavingMicro: 0, tokens },
  ];
  return {
    id,
    createdAt,
    running: options.running === true,
    isSubagent: options.isSubagent === true,
    costMicroCny: options.costMicroCny ?? 1000,
    cacheSavingMicro: models.reduce((sum, model) => sum + model.cacheSavingMicro, 0),
    tokens,
    models,
  };
}

function modelRecord(provider, model, costMicroCny, tokens, priced = true, cacheSavingMicro = 0) {
  return { provider, model, priced, costMicroCny, cacheSavingMicro, tokens };
}

/* ------------------------------------------------------------------ ranges */

test('localMidnight uses the local day boundary, not UTC', () => {
  assert.equal(localMidnight(NOW), TODAY);
  assert.equal(localMidnight(TODAY), TODAY);
  assert.equal(localMidnight(new Date(2026, 9, 24, 23, 59, 59, 999).getTime()), TODAY);
  assert.equal(localMidnight(new Date(2026, 9, 23, 23, 59, 59, 999).getTime()), new Date(2026, 9, 23).getTime());
});

test('rangeCutoff returns inclusive bounds and 0 for all/unknown', () => {
  assert.equal(rangeCutoff('today', NOW), TODAY);
  assert.equal(rangeCutoff('7d', NOW), NOW - 7 * DAY_MS);
  assert.equal(rangeCutoff('30d', NOW), NOW - 30 * DAY_MS);
  assert.equal(rangeCutoff('all', NOW), 0);
  assert.equal(rangeCutoff('nonsense', NOW), 0);
  assert.equal(rangeCutoff('today', undefined) > 0, true);
});

test('normalizeTimeRange clamps unknown / missing values to all', () => {
  for (const range of TIME_RANGES) assert.equal(normalizeTimeRange(range), range);
  for (const value of ['', 'All', 'today ', 'yesterday', null, undefined, 0, {}, []]) {
    assert.equal(normalizeTimeRange(value), 'all');
  }
});

test('sessionMatchesRange keeps boundary instants and rejects just-outside ones', () => {
  // Today includes 00:00:00.000 through 23:59:59.999.
  assert.equal(sessionMatchesRange(TODAY, 'today', NOW), true);
  assert.equal(sessionMatchesRange(TODAY - 1, 'today', NOW), false);
  assert.equal(sessionMatchesRange(new Date(2026, 9, 24, 23, 59, 59, 999).getTime(), 'today', NOW), true);
  assert.equal(sessionMatchesRange(new Date(2026, 9, 23, 23, 59, 59, 999).getTime(), 'today', NOW), false);

  const cutoff7 = rangeCutoff('7d', NOW);
  assert.equal(sessionMatchesRange(cutoff7, '7d', NOW), true);
  assert.equal(sessionMatchesRange(cutoff7 - 1, '7d', NOW), false);
  const cutoff30 = rangeCutoff('30d', NOW);
  assert.equal(sessionMatchesRange(cutoff30, '30d', NOW), true);
  assert.equal(sessionMatchesRange(cutoff30 - 1, '30d', NOW), false);

  // Every range admits everything in `all`.
  assert.equal(sessionMatchesRange(null, 'all', NOW), true);
});

test('sessions without a usable createdAt are never filtered out', () => {
  for (const missing of [null, undefined, NaN, 0, -1, '', '1792830000000', {}]) {
    for (const range of ['today', '7d', '30d']) {
      assert.equal(sessionMatchesRange(missing, range, NOW), true, `range=${range} value=${String(missing)}`);
    }
  }
});

test('filterSessionsByRange preserves order and spans the four windows', () => {
  const sessions = [
    { id: 'today', createdAt: NOW },
    { id: 'two-days', createdAt: NOW - 2 * DAY_MS },
    { id: 'ten-days', createdAt: NOW - 10 * DAY_MS },
    { id: 'forty-days', createdAt: NOW - 40 * DAY_MS },
    { id: 'undated', createdAt: null },
  ];
  const ids = (range) => filterSessionsByRange(sessions, range, NOW).map((session) => session.id);
  assert.deepEqual(ids('today'), ['today', 'undated']);
  assert.deepEqual(ids('7d'), ['today', 'two-days', 'undated']);
  assert.deepEqual(ids('30d'), ['today', 'two-days', 'ten-days', 'undated']);
  assert.deepEqual(ids('all'), sessions.map((session) => session.id));
  assert.deepEqual(filterSessionsByRange(null, 'all', NOW), []);
  assert.deepEqual(filterSessionsByRange(undefined, 'today', NOW), []);
});

test('formatRangeLabel / formatDay render stable local captions', () => {
  assert.equal(formatRangeLabel('all', NOW), '全部时间');
  assert.equal(formatRangeLabel('today', NOW), `今天（${formatDay(NOW)}）`);
  assert.equal(formatRangeLabel('7d', NOW), `最近 7 天（${formatDay(NOW - 7 * DAY_MS)} 起）`);
  assert.equal(formatRangeLabel('30d', NOW), `最近 30 天（${formatDay(NOW - 30 * DAY_MS)} 起）`);
  assert.equal(formatRangeLabel('bogus', NOW), '全部时间');
  assert.equal(formatDay(NOW), '2026-10-24');
  assert.equal(formatDay(NaN), '—');
});

/* ------------------------------------------------------------------- stats */

test('aggregateRangeStats mirrors the report summary arithmetic', () => {
  const aTokens = bucket(1000, 100, 20, 3000);
  const bTokens = bucket(2000, 200, 0, 1000);
  const sessions = [
    datasetRecord('a', NOW, {
      costMicroCny: 500,
      tokens: aTokens,
      models: [
        modelRecord('p', 'm1', 400, aTokens, true, 20),
        modelRecord('q', 'm2', 100, bucket(1, 1, 1, 1), false, 0),
      ],
    }),
    datasetRecord('b', NOW - DAY_MS, {
      costMicroCny: 0,
      tokens: bTokens,
      models: [modelRecord('p', 'm1', 0, bTokens, true, 0)],
    }),
  ];
  const stats = aggregateRangeStats(sessions);

  assert.equal(stats.sessions, 2);
  assert.equal(stats.pricedSessions, 1);
  assert.equal(stats.uncachedInputTokens, 3000);
  assert.equal(stats.outputTokens, 300);
  assert.equal(stats.cacheWriteTokens, 20);
  assert.equal(stats.cacheReadTokens, 4000);
  assert.equal(stats.totalTokens, 3000 + 300 + 20 + 4000);
  assert.equal(stats.costMicroCny, 500);
  assert.equal(stats.cacheSavingMicro, 20);
  assert.equal(stats.cacheHit, 0.5698);

  assert.equal(stats.models.length, 2);
  const [m1, m2] = stats.models;
  assert.equal(m1.model, 'm1');
  assert.equal(m1.sessions, 2);
  assert.equal(m1.costMicroCny, 400);
  assert.deepEqual(m1.tokens, { uncachedInputTokens: 3000, outputTokens: 300, cacheWriteTokens: 20, cacheReadTokens: 4000 });
  assert.equal(m2.model, 'm2');
  assert.equal(m2.priced, false);
  assert.equal(m2.sessions, 1);

  const empty = aggregateRangeStats([]);
  assert.equal(empty.sessions, 0);
  assert.equal(empty.cacheHit, null);
  assert.deepEqual(empty.models, []);
  assert.deepEqual(zeroTokens(), { uncachedInputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 });
});

/* -------------------------------------------------- serialized browser runtime */

test('timeRangeRuntimeSource exposes the same behavior in a browser-like realm', () => {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(timeRangeRuntimeSource(), context);
  const runtime = context.window.DSH_TIME_RANGE;
  assert.ok(runtime, 'window.DSH_TIME_RANGE must exist');
  assert.deepEqual([...runtime.ranges], [...TIME_RANGES]);
  assert.equal(runtime.storageKey, TIME_RANGE_STORAGE_KEY);
  assert.equal(runtime.dayMs, DAY_MS);

  const sessions = [
    { id: 'today', createdAt: NOW },
    { id: 'old', createdAt: NOW - 10 * DAY_MS },
    { id: 'none', createdAt: null },
  ];
  for (const range of ['today', '7d', '30d', 'all']) {
    assert.deepEqual(
      [...runtime.filterSessionsByRange(sessions, range, NOW).map((session) => session.id)],
      filterSessionsByRange(sessions, range, NOW).map((session) => session.id),
      `range ${range}`,
    );
  }
  assert.equal(runtime.localMidnight(NOW), TODAY);
  assert.equal(runtime.formatRangeLabel('today', NOW), formatRangeLabel('today', NOW));
  assert.equal(runtime.aggregateRangeStats(sessions).sessions, 3);
  assert.equal(runtime.normalizeTimeRange('bogus'), 'all');
  // The runtime source must remain self-contained (no imports/Module syntax).
  assert.doesNotMatch(timeRangeRuntimeSource(), /\bimport\b|export /u);
});

/* ------------------------------------------------------------------- DOM */

/** Minimal DOM node: attributes, classList, textContent, innerHTML. */
function makeNode(attributes = {}) {
  const attrs = new Map(Object.entries(attributes).map(([key, value]) => [key, String(value)]));
  const classes = new Set();
  const node = {
    textContent: '',
    innerHTML: '',
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
    setAttribute(name, value) {
      attrs.set(name, String(value));
    },
    removeAttribute(name) {
      attrs.delete(name);
    },
    hasAttribute(name) {
      return attrs.has(name);
    },
    classList: {
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : force === true;
        if (on) classes.add(name);
        else classes.delete(name);
      },
      add(name) {
        classes.add(name);
      },
      remove(name) {
        classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
    },
    addEventListener(type, handler) {
      if (type === 'click') node.clickHandler = handler;
    },
    contains() {
      return true;
    },
  };
  return node;
}

/**
 * Fake document with the exact nodes `applyTimeRange` touches: session rows,
 * detail rows, cards, model tbody, range bar/buttons, empty row, more button.
 */
function makeDom(records, pageSize = 5) {
  const nodes = new Map();
  const rows = [];
  const buttons = [];
  const section = makeNode();
  nodes.set('sessions', section);

  records.forEach((record, index) => {
    const target = `detail-${index}`;
    const row = makeNode({
      'data-session': record.id,
      'data-target': target,
      'data-created-at': record.createdAt === null || record.createdAt === undefined ? '' : record.createdAt,
    });
    if (index >= pageSize) {
      row.setAttribute('hidden', '');
      row.classList.toggle('session-extra', true);
    }
    rows.push(row);
    const detail = makeNode({ id: target, 'data-session': record.id });
    if (index >= pageSize) {
      detail.setAttribute('hidden', '');
      detail.classList.toggle('session-extra', true);
    }
    nodes.set(target, detail);
  });
  section.querySelectorAll = (selector) => (selector === 'tr.session' ? rows : []);

  const dataNode = makeNode();
  dataNode.textContent = JSON.stringify({ pageSize, sessions: records });
  nodes.set('dsh-cost-data', dataNode);

  for (const id of [
    'stat-cost',
    'stat-cost-note',
    'stat-tokens',
    'stat-tokens-note',
    'stat-cache-read',
    'stat-cache-read-note',
    'stat-cache-saving',
    'model-summary-body',
  ]) {
    nodes.set(id, makeNode());
  }
  const empty = makeNode({ hidden: '' });
  nodes.set('sessions-empty', empty);

  const bar = makeNode();
  nodes.set('dsh-cost-range', bar);
  const note = makeNode();
  const flag = makeNode({ hidden: '' });
  const more = makeNode();
  const toggle = makeNode();
  for (const range of ['all', '30d', '7d', 'today']) {
    const button = makeNode({ 'data-range': range, 'aria-pressed': range === 'all' ? 'true' : 'false' });
    if (range === 'all') button.classList.add('active');
    buttons.push(button);
  }

  const doc = {
    getElementById(id) {
      return nodes.get(id) ?? null;
    },
    querySelector(selector) {
      if (selector === '[data-sessions-more]') return more;
      if (selector === '[data-sessions-toggle]') return toggle;
      if (selector === '[data-range-note]') return note;
      if (selector === '[data-range-flag]') return flag;
      return null;
    },
    querySelectorAll(selector) {
      return selector === '.time-range-selector .range-btn' ? buttons : [];
    },
  };
  return { doc, rows, buttons, nodes, note, flag, more, toggle, bar };
}

function runtimeForTests() {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(timeRangeRuntimeSource(), context);
  return context.window.DSH_TIME_RANGE;
}

const runtime = runtimeForTests();

test('applyTimeRange on All time reproduces the server numbers and pages rows', () => {
  const records = [
    datasetRecord('s0', NOW, { costMicroCny: 300 }),
    datasetRecord('s1', NOW - DAY_MS, { costMicroCny: 200 }),
    datasetRecord('s2', NOW - 2 * DAY_MS, { costMicroCny: 100 }),
    datasetRecord('s3', NOW - 3 * DAY_MS, { costMicroCny: 50 }),
    datasetRecord('s4', NOW - 4 * DAY_MS, { costMicroCny: 25 }),
    datasetRecord('s5', NOW - 5 * DAY_MS, { costMicroCny: 10 }),
  ];
  const dom = makeDom(records);
  const result = runtime.applyTimeRange(dom.doc, { range: 'all', now: NOW });
  const stats = aggregateRangeStats(records);

  assert.equal(result.range, 'all');
  assert.equal(result.kept, 6);
  assert.equal(result.total, 6);
  assert.equal(result.extra, 1);
  assert.equal(dom.rows.filter((row) => row.hasAttribute('hidden')).length, 1);
  assert.equal(dom.rows[5].classList.contains('session-extra'), true);
  assert.equal(dom.rows[5].getAttribute('data-range-hidden'), null);

  assert.equal(dom.nodes.get('stat-cost').textContent, formatCny(stats.costMicroCny / 1e6));
  assert.equal(dom.nodes.get('stat-tokens').textContent, formatTokens(stats.totalTokens));
  assert.equal(dom.nodes.get('stat-cost-note').textContent, `6 / 6 个会话产生费用`);
  assert.equal(dom.more.hasAttribute('hidden'), false);
  assert.equal(dom.toggle.textContent, '显示更多（还有 1 个）');
  assert.equal(dom.note.textContent, '全部时间 · 6 个会话');
  assert.equal(dom.bar.getAttribute('data-filtered'), 'false');
  assert.equal(dom.flag.hasAttribute('hidden'), true);
  assert.equal(dom.buttons[0].classList.contains('active'), true);
  assert.equal(dom.nodes.get('model-summary-body').innerHTML.includes('m1'), true);
});

test('applyTimeRange hides out-of-range rows, closes their details, and re-pages survivors', () => {
  const records = [
    datasetRecord('today-1', NOW - 3600_000),
    datasetRecord('today-2', NOW - 2 * 3600_000),
    datasetRecord('old-2d', NOW - 2 * DAY_MS),
    datasetRecord('old-10d', NOW - 10 * DAY_MS),
    datasetRecord('undated', null),
  ];
  const dom = makeDom(records);
  const result = runtime.applyTimeRange(dom.doc, { range: 'today', now: NOW });
  const expected = filterSessionsByRange(records, 'today', NOW);
  const stats = aggregateRangeStats(expected);

  assert.equal(result.kept, 3);
  assert.equal(result.total, 5);
  assert.deepEqual(
    dom.rows.map((row) => row.hasAttribute('data-range-hidden')),
    [false, false, true, true, false],
  );
  assert.equal(dom.rows[2].hasAttribute('hidden'), true);
  assert.equal(dom.more.hasAttribute('hidden'), true, 'three survivors fit on one page');

  // An open detail row for a hidden session must be closed again.
  const filteredDetail = dom.doc.getElementById(dom.rows[2].getAttribute('data-target'));
  filteredDetail.classList.add('open');
  runtime.applyTimeRange(dom.doc, { range: 'today', now: NOW });
  assert.equal(filteredDetail.classList.contains('open'), false);

  assert.equal(dom.nodes.get('stat-tokens').textContent, formatTokens(stats.totalTokens));
  assert.equal(dom.note.textContent, `${formatRangeLabel('today', NOW)} · 3 / 5 个会话`);
  assert.equal(dom.flag.hasAttribute('hidden'), false);
  assert.equal(dom.buttons[3].classList.contains('active'), true);
  assert.equal(dom.buttons[0].classList.contains('active'), false);
});

test('applyTimeRange shows the empty state when nothing matches', () => {
  const records = [
    datasetRecord('old-10d', NOW - 10 * DAY_MS),
    datasetRecord('old-40d', NOW - 40 * DAY_MS),
  ];
  const dom = makeDom(records);
  const result = runtime.applyTimeRange(dom.doc, { range: 'today', now: NOW });
  assert.equal(result.kept, 0);
  assert.equal(dom.nodes.get('sessions-empty').hasAttribute('hidden'), false);
  assert.equal(dom.nodes.get('model-summary-body').innerHTML.includes('没有用量记录'), true);
  assert.equal(dom.more.hasAttribute('hidden'), true);
  assert.equal(dom.note.textContent, `${formatRangeLabel('today', NOW)} · 0 / 2 个会话`);
  assert.equal(dom.toggle.textContent.includes('显示更多'), true);
});

test('showAll reveals every filtered row and switches the button label', () => {
  const records = Array.from({ length: 7 }, (_, index) =>
    datasetRecord(`s${index}`, NOW - index * 3600_000),
  );
  const dom = makeDom(records);
  runtime.applyTimeRange(dom.doc, { range: 'all', showAll: false, now: NOW });
  assert.equal(dom.rows.filter((row) => row.hasAttribute('hidden')).length, 2);

  runtime.applyTimeRange(dom.doc, { range: 'all', showAll: true, now: NOW });
  assert.equal(dom.rows.filter((row) => row.hasAttribute('hidden')).length, 0);
  assert.equal(dom.toggle.textContent, '收起');
  assert.equal(dom.toggle.getAttribute('aria-expanded'), 'true');

  runtime.applyTimeRange(dom.doc, { range: 'all', showAll: false, now: NOW });
  assert.equal(dom.toggle.textContent, '显示更多（还有 2 个）');
});

test('readSavedRange / saveRange persist only known values and tolerate blocked storage', () => {
  const storage = {
    value: null,
    getItem(key) {
      assert.equal(key, TIME_RANGE_STORAGE_KEY);
      return this.value;
    },
    setItem(key, value) {
      assert.equal(key, TIME_RANGE_STORAGE_KEY);
      this.value = value;
    },
  };
  assert.equal(runtime.readSavedRange(storage), 'all');
  runtime.saveRange(storage, '7d');
  assert.equal(storage.value, '7d');
  assert.equal(runtime.readSavedRange(storage), '7d');
  storage.value = 'nonsense';
  assert.equal(runtime.readSavedRange(storage), 'all');
  runtime.saveRange(storage, 'nonsense');
  assert.equal(storage.value, 'all');

  const blocked = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
  };
  assert.equal(runtime.readSavedRange(blocked), 'all');
  assert.doesNotThrow(() => runtime.saveRange(blocked, 'today'));
  assert.equal(runtime.readSavedRange(null), 'all');
});

test('bindRangeSelector dispatches clicks on the four buttons', () => {
  const bar = makeNode();
  const doc = { getElementById: (id) => (id === 'dsh-cost-range' ? bar : null) };
  const calls = [];
  runtime.bindRangeSelector(doc, (range) => calls.push(range));
  const button = { getAttribute: () => '7d' };
  let prevented = false;
  bar.clickHandler({ target: { closest: () => button }, preventDefault: () => { prevented = true; } });
  assert.deepEqual(calls, ['7d']);
  assert.equal(prevented, true);

  // A click outside any range button is ignored.
  bar.clickHandler({ target: { closest: () => null }, preventDefault: () => {} });
  assert.deepEqual(calls, ['7d']);
});

/* ------------------------------------------- server-rendered report payload */

test('renderHtml embeds the selector, row timestamps, and the filter dataset', () => {
  const pricing = normalizePricing(DEFAULT_PRICING);
  const tokens = bucket(1000, 100, 0, 9000);
  const sessions = [
    {
      id: 's-today',
      title: '今日会话',
      cwd: 'F:\\x',
      workspaceDir: '--F-x--',
      agentPreset: 'standard',
      running: false,
      isSubagent: false,
      createdAt: NOW,
      totals: { ...tokens, costCny: 0.001, costMicroCny: 1000, cacheHit: 0.9, samples: 1 },
      models: [
        {
          provider: 'opencode-go',
          model: 'deepseek-v4.1-flash',
          priceKey: 'deepseek-v4.1-flash',
          priced: true,
          tokens,
          costCny: 0.001,
          costMicroCny: 1000,
          share: 1,
          samples: 1,
        },
      ],
    },
    {
      id: 's-undated',
      title: '无日期会话',
      cwd: 'F:\\x',
      workspaceDir: '--F-x--',
      agentPreset: 'standard',
      running: false,
      isSubagent: false,
      createdAt: null,
      totals: { ...bucket(1, 1, 0, 1), costCny: 0, costMicroCny: 0, cacheHit: 0.5, samples: 1 },
      models: [
        {
          provider: 'unknown',
          model: 'mystery-model',
          priceKey: null,
          priced: false,
          tokens: bucket(1, 1, 0, 1),
          costCny: 0,
          costMicroCny: 0,
          share: 1,
          samples: 1,
        },
      ],
    },
  ];
  const report = {
    generatedAt: NOW,
    home: 'C:\\tmp\\.dsh',
    currency: 'CNY',
    unitTokens: 1000000,
    pricing,
    summary: {
      sessions: 2,
      pricedSessions: 1,
      inputTokens: 1001,
      outputTokens: 101,
      cacheWriteTokens: 0,
      cacheReadTokens: 9001,
      totalTokens: 10103,
      costCny: 0.001,
      costMicroCny: 1000,
      cacheHit: 0.9,
      unpricedModels: ['mystery-model'],
    },
    sessions,
  };
  const html = renderHtml(report);

  assert.match(html, /id="dsh-cost-range"/u);
  for (const range of ['all', '30d', '7d', 'today']) {
    assert.match(html, new RegExp(`data-range="${range}"`, 'u'));
  }
  assert.match(html, /data-range="all" aria-pressed="true"/u);
  assert.match(html, new RegExp(`data-created-at="${NOW}"`, 'u'));
  assert.match(html, /data-created-at=""/u);
  // No-JS fallback: expand every session row, hide controls that need script.
  assert.match(html, /<noscript><style>/u);
  assert.match(html, /tr\.session\.session-extra\[hidden\]/u);

  const match = /<script type="application\/json" id="dsh-cost-data">([\s\S]*?)<\/script>/u.exec(html);
  assert.ok(match, 'dataset script must be embedded');
  const dataset = JSON.parse(match[1]);
  assert.equal(dataset.pageSize, 5);
  assert.equal(dataset.sessions.length, 2);
  assert.equal(dataset.sessions[0].id, 's-today');
  assert.equal(dataset.sessions[0].createdAt, NOW);
  assert.equal(dataset.sessions[1].createdAt, null);
  // 9000 × (0.15 − 0.003) = 1323 micro-CNY, rounded per model.
  assert.equal(dataset.sessions[0].cacheSavingMicro, 1323);
  assert.equal(dataset.sessions[0].models[0].cacheSavingMicro, 1323);
  assert.equal(dataset.sessions[1].models[0].priced, false);
  assert.equal(dataset.sessions[1].cacheSavingMicro, 0);
  // No-JS: every session row is present in the document.
  assert.equal((html.match(/<tr class="session[^"]*"/gu) ?? []).length, 2);
});

test('buildTimeRangeDataset rounds cache savings per model', () => {
  const pricing = normalizePricing(DEFAULT_PRICING);
  const built = buildTimeRangeDataset({
    sessions: [
      {
        id: 'x',
        createdAt: NOW,
        running: false,
        isSubagent: false,
        totals: { ...bucket(10, 2, 0, 100), costMicroCny: 500, costCny: 0.0005, cacheHit: 0.9, samples: 1 },
        models: [
          {
            provider: 'opencode-go',
            model: 'deepseek-v4.1-flash',
            priced: true,
            tokens: bucket(10, 2, 0, 100),
            costMicroCny: 500,
          },
          {
            provider: 'q',
            model: 'unpriced',
            priced: false,
            tokens: bucket(1, 1, 1, 1),
            costMicroCny: 0,
          },
        ],
      },
    ],
    pricing,
    pageSize: 3,
  });
  assert.equal(built.pageSize, 3);
  assert.equal(built.sessions[0].models[0].cacheSavingMicro, 15); // round(100 × 0.147)
  assert.equal(built.sessions[0].models[1].cacheSavingMicro, 0);
  assert.equal(built.sessions[0].cacheSavingMicro, 15);
  assert.equal(built.sessions[0].tokens.totalTokens, 112);
});

/* ------------------------------- generated page + runtime integration */

/** Built (report-shaped) session record with one priced model. */
function builtSession(id, createdAt, costMicroCny) {
  const tokens = bucket(1000, 100, 0, 9000);
  return {
    id,
    title: id,
    cwd: 'F:\\x',
    workspaceDir: '--F-x--',
    agentPreset: 'standard',
    running: false,
    isSubagent: false,
    createdAt,
    totals: { ...tokens, costCny: costMicroCny / 1e6, costMicroCny, cacheHit: 0.9, samples: 1 },
    models: [
      {
        provider: 'opencode-go',
        model: 'deepseek-v4.1-flash',
        priceKey: 'deepseek-v4.1-flash',
        priced: true,
        tokens,
        costCny: costMicroCny / 1e6,
        costMicroCny,
        share: 1,
        samples: 1,
      },
    ],
  };
}

/** Report object shaped like `buildReport()`'s output (summary recomputed). */
function makeReport(records) {
  const totals = records.reduce(
    (acc, session) => {
      acc.sessions += 1;
      if (session.totals.costMicroCny > 0) acc.pricedSessions += 1;
      acc.inputTokens += session.totals.uncachedInputTokens;
      acc.outputTokens += session.totals.outputTokens;
      acc.cacheWriteTokens += session.totals.cacheWriteTokens;
      acc.cacheReadTokens += session.totals.cacheReadTokens;
      acc.totalTokens += session.totals.totalTokens;
      acc.costMicroCny += session.totals.costMicroCny;
      return acc;
    },
    {
      sessions: 0,
      pricedSessions: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      costMicroCny: 0,
    },
  );
  const billed = totals.inputTokens + totals.cacheWriteTokens + totals.cacheReadTokens;
  return {
    generatedAt: NOW,
    home: 'C:\\tmp\\.dsh',
    currency: 'CNY',
    unitTokens: 1000000,
    pricing: normalizePricing(DEFAULT_PRICING),
    summary: {
      ...totals,
      costCny: totals.costMicroCny / 1e6,
      cacheHit: billed === 0 ? null : Math.round((totals.cacheReadTokens / billed) * 10000) / 10000,
      unpricedModels: [],
    },
    sessions: records,
  };
}

test('the generated page and the serialized runtime agree for every range', () => {
  const records = [
    builtSession('r-today-a', NOW, 7000),
    builtSession('r-today-b', NOW - 3 * 3600_000, 6000),
    builtSession('r-1d', NOW - DAY_MS, 5000),
    builtSession('r-3d', NOW - 3 * DAY_MS, 4000),
    builtSession('r-10d', NOW - 10 * DAY_MS, 3000),
    builtSession('r-40d', NOW - 40 * DAY_MS, 2000),
    builtSession('r-undated', null, 1000),
  ];
  const html = renderHtml(makeReport(records));
  const dataset = JSON.parse(
    /<script type="application\/json" id="dsh-cost-data">([\s\S]*?)<\/script>/u.exec(html)[1],
  );
  const textOfId = (id) => {
    const match = new RegExp(`id="${id}">([^<]*)<`, 'u').exec(html);
    return match ? match[1] : null;
  };

  // Default (All time) view: the client-applied numbers must equal the server's.
  const dom = makeDom(dataset.sessions, dataset.pageSize);
  const result = runtime.applyTimeRange(dom.doc, { range: 'all', now: NOW });
  assert.equal(result.kept, 7);
  for (const id of [
    'stat-cost',
    'stat-cost-note',
    'stat-tokens',
    'stat-tokens-note',
    'stat-cache-read',
    'stat-cache-read-note',
    'stat-cache-saving',
  ]) {
    assert.equal(dom.nodes.get(id).textContent, textOfId(id), `card ${id}`);
  }
  const serverNote = /<span class="range-note" data-range-note[^>]*>([^<]*)<\/span>/u.exec(html);
  assert.equal(dom.note.textContent, serverNote[1]);
  assert.equal(dom.toggle.textContent, '显示更多（还有 2 个）');
  assert.equal(dom.rows.filter((row) => row.hasAttribute('hidden')).length, 2);

  // The server-rendered model table and the client rebuild list the same models.
  const serverModelBody = /<tbody id="model-summary-body">([\s\S]*?)<\/tbody>/u.exec(html)[1];
  const runtimeModelBody = dom.nodes.get('model-summary-body').innerHTML;
  for (const match of serverModelBody.matchAll(/<td class="mono">([^<]*)<\/td>/gu)) {
    assert.ok(runtimeModelBody.includes(match[1]), `model ${match[1]}`);
  }

  // Each range keeps exactly the sessions the pure filter selects, in order.
  for (const range of ['today', '7d', '30d', 'all']) {
    const expected = filterSessionsByRange(dataset.sessions, range, NOW);
    const rangedDom = makeDom(dataset.sessions, dataset.pageSize);
    const ranged = runtime.applyTimeRange(rangedDom.doc, { range, now: NOW });
    assert.equal(ranged.kept, expected.length, `range ${range} kept`);
    assert.deepEqual(
      rangedDom.rows
        .filter((row) => !row.hasAttribute('data-range-hidden'))
        .map((row) => row.getAttribute('data-session')),
      expected.map((session) => session.id),
      `range ${range} visible rows`,
    );
  }
  assert.equal(filterSessionsByRange(dataset.sessions, 'today', NOW).length, 3);
  assert.equal(filterSessionsByRange(dataset.sessions, '7d', NOW).length, 5);
  assert.equal(filterSessionsByRange(dataset.sessions, '30d', NOW).length, 6);
});
