import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { analyzeEvents } from '../src/engine.mjs';
import { DEFAULT_PRICING, formatCny, formatTokens, normalizePricing } from '../src/pricing.mjs';
import { buildDailyReport, buildReport, buildTimeRangeDataset } from '../src/report-data.mjs';
import { renderHtml } from '../src/report-html.mjs';
import {
  aggregateDayStats,
  dayMatchesRange,
  formatDailyRangeLabel,
  normalizeView,
  rangeDayCutoff,
  timeRangeRuntimeSource,
} from '../src/time-range.mjs';

const pricing = normalizePricing(DEFAULT_PRICING);
const DAY_MS = 86_400_000;
const NOW = new Date(2026, 9, 26, 12, 0, 0).getTime();
const LATE = new Date(2026, 9, 25, 23, 50, 0).getTime();
const EARLY = new Date(2026, 9, 26, 0, 10, 0).getTime();

function makeResult(id, samples, meta = {}) {
  const events = [];
  let seq = 0;
  samples.forEach((sample, index) => {
    events.push({
      type: 'request/header',
      seq: (seq += 1),
      time: sample.time,
      data: { header: { config: { provider: sample.provider ?? 'aicodemirror1', model: sample.model ?? 'claude-sonnet-5-5' } } },
    });
    events.push({
      type: 'assistant/message',
      seq: (seq += 1),
      time: sample.time,
      data: { turn: index + 1, step: 1, usage: sample.usage },
    });
  });
  return {
    meta: {
      id,
      title: id,
      createdAt: meta.createdAt ?? NOW,
      running: meta.running === true,
      isSubagent: meta.isSubagent === true,
      cwd: 'F:\\test',
      workspaceDir: '--F-test--',
      agentPreset: 'standard',
    },
    analysis: analyzeEvents(events, pricing),
    projection: null,
  };
}

const usages = {
  small: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 10_000, cacheWriteTokens: 0 },
  large: { inputTokens: 3000, outputTokens: 600, cacheReadTokens: 40_000, cacheWriteTokens: 0 },
};

function crossMidnightReport() {
  const results = [
    makeResult('citeflow', [
      { time: LATE, usage: usages.small },
      { time: EARLY, usage: usages.large },
    ]),
    makeResult('other', [{ time: EARLY + 3_600_000, usage: usages.small }]),
  ];
  return { results, report: buildReport({ home: 'F:\\test', pricing, results, generatedAt: NOW }) };
}

test('buildDailyReport splits a session across local midnight without changing totals', () => {
  const { report } = crossMidnightReport();
  const days = report.daily.days;
  assert.equal(days.length, 2);
  assert.deepEqual(days.map((day) => day.day), ['2026-10-26', '2026-10-25']);

  const late = days.find((day) => day.day === '2026-10-25');
  const early = days.find((day) => day.day === '2026-10-26');
  assert.equal(late.totals.samples, 1);
  assert.equal(early.totals.samples, 2);

  const lateCite = late.sessions.find((session) => session.id === 'citeflow');
  const earlyCite = early.sessions.find((session) => session.id === 'citeflow');
  assert.equal(lateCite.samples, 1);
  assert.equal(earlyCite.samples, 1);
  assert.ok(lateCite.costMicroCny > 0 && earlyCite.costMicroCny > 0);

  const sessionTotal = report.sessions.find((session) => session.id === 'citeflow');
  assert.equal(lateCite.costMicroCny + earlyCite.costMicroCny, sessionTotal.totals.costMicroCny);
  assert.equal(
    lateCite.tokens.totalTokens + earlyCite.tokens.totalTokens,
    sessionTotal.totals.totalTokens,
  );
  assert.equal(
    days.reduce((sum, day) => sum + day.totals.costMicroCny, 0),
    report.summary.costMicroCny,
  );
  assert.equal(
    days.reduce((sum, day) => sum + day.totals.totalTokens, 0),
    report.summary.totalTokens,
  );
});

test('samples without a timestamp land in the unknown bucket and only show under all time', () => {
  const results = [
    makeResult('undated', [{ usage: usages.small }]),
    makeResult('dated', [{ time: EARLY, usage: usages.large }]),
  ];
  const { days } = buildDailyReport(results, pricing);
  const unknown = days.find((day) => day.unknown === true);
  assert.ok(unknown, 'an unknown bucket must exist');
  assert.equal(unknown.day, 'unknown');
  assert.equal(unknown.dayStart, 0);
  assert.equal(unknown.totals.samples, 1);

  assert.equal(dayMatchesRange(0, 'today', NOW), false);
  assert.equal(dayMatchesRange(0, 'all', NOW), true);
  assert.equal(dayMatchesRange(unknown.dayStart, '30d', NOW), false);
});

test('rangeDayCutoff and dayMatchesRange use calendar days for the daily view', () => {
  const today = new Date(2026, 9, 26).getTime();
  const day7 = new Date(2026, 9, 20).getTime();
  const day30 = new Date(2026, 8, 27).getTime();

  assert.equal(rangeDayCutoff('today', NOW), today);
  assert.equal(rangeDayCutoff('7d', NOW), day7);
  assert.equal(rangeDayCutoff('30d', NOW), day30);
  assert.equal(rangeDayCutoff('all', NOW), 0);

  assert.equal(dayMatchesRange(today, 'today', NOW), true);
  assert.equal(dayMatchesRange(today - 1, 'today', NOW), false);
  assert.equal(dayMatchesRange(day7, '7d', NOW), true);
  assert.equal(dayMatchesRange(day7 - 1, '7d', NOW), false);
  assert.equal(dayMatchesRange(day30, '30d', NOW), true);
  assert.equal(dayMatchesRange(day30 - 1, '30d', NOW), false);
  assert.ok(formatDailyRangeLabel('7d', NOW).includes('2026-10-20'));
  assert.equal(normalizeView('daily'), 'daily');
  assert.equal(normalizeView('bogus'), 'session');
});

test('aggregateDayStats counts distinct sessions and sums models across days', () => {
  const model = (costMicroCny, cacheSavingMicro = 0) => ({
    provider: 'p',
    model: 'm',
    priced: true,
    costMicroCny,
    cacheSavingMicro,
    tokens: { uncachedInputTokens: 10, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 100, totalTokens: 115 },
  });
  const days = [
    {
      totals: { uncachedInputTokens: 10, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 100, totalTokens: 115, costMicroCny: 100, cacheSavingMicro: 10, samples: 1 },
      sessions: [{ id: 'a', costMicroCny: 100, models: [model(100, 10)] }],
    },
    {
      totals: { uncachedInputTokens: 20, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 200, totalTokens: 230, costMicroCny: 150, cacheSavingMicro: 20, samples: 2 },
      sessions: [
        { id: 'a', costMicroCny: 100, models: [model(100, 10)] },
        { id: 'b', costMicroCny: 50, models: [model(50, 10)] },
      ],
    },
  ];
  const stats = aggregateDayStats(days);
  assert.equal(stats.days, 2);
  assert.equal(stats.sessions, 2);
  assert.equal(stats.pricedSessions, 2);
  assert.equal(stats.costMicroCny, 250);
  assert.equal(stats.cacheSavingMicro, 30);
  assert.equal(stats.totalTokens, 345);
  assert.equal(stats.samples, 3);
  assert.equal(stats.models.length, 1);
  assert.equal(stats.models[0].costMicroCny, 250);
  assert.equal(stats.models[0].sessions, 2);
  assert.equal(stats.cacheHit, 0.9091);
});

test('renderHtml embeds the daily view, toggle, and split buckets', () => {
  const { report } = crossMidnightReport();
  const html = renderHtml(report);
  assert.match(html, /id="daily"/u);
  assert.match(html, /data-view="daily"/u);
  assert.match(html, /按天费用（按采样时间切日 · 跨天会话会拆分/u);
  assert.match(html, /data-day-start="/u);
  assert.match(html, /"days":\[/u);
  assert.match(html, /"day":"2026-10-25"/u);
  assert.match(html, /"day":"2026-10-26"/u);
  assert.match(html, /citeflow/u);
  assert.match(html, /view-btn/u);
});

test('applyTimeRange in daily mode filters days by sample date and updates cards', () => {
  const { report } = crossMidnightReport();
  const dataset = buildTimeRangeDataset({ sessions: [], daily: report.daily, pricing });
  const dom = makeDailyDom(dataset.days);
  const runtime = runtimeForTests();

  const result = runtime.applyTimeRange(dom.doc, { range: 'today', view: 'daily', now: NOW });
  assert.equal(result.view, 'daily');
  assert.equal(result.days, 1);
  assert.equal(dom.nodes.get('sessions').hasAttribute('hidden'), true);
  assert.equal(dom.nodes.get('daily').hasAttribute('hidden'), false);
  assert.deepEqual(
    dom.rows.map((row) => row.hasAttribute('data-range-hidden')),
    [false, true],
  );
  const todayStats = aggregateDayStats([dataset.days[0]]);
  assert.equal(dom.nodes.get('stat-cost').textContent, formatCny(todayStats.costMicroCny / 1e6));
  assert.equal(dom.nodes.get('stat-tokens').textContent, formatTokens(todayStats.totalTokens));
  assert.match(dom.nodes.get('model-summary-body').innerHTML, /claude-sonnet-5-5/u);
  assert.match(dom.note.textContent, /今天（2026-10-26）/u);
  assert.match(dom.note.textContent, /2 个会话 \/ 1 天/u);
  assert.equal(dom.nodes.get('daily-empty').hasAttribute('hidden'), true);

  runtime.applyTimeRange(dom.doc, { range: 'all', view: 'session', now: NOW });
  assert.equal(dom.nodes.get('daily').hasAttribute('hidden'), true);
  assert.equal(dom.nodes.get('sessions').hasAttribute('hidden'), false);
});

test('the daily runtime is self-contained and exposes storage helpers', () => {
  const runtime = runtimeForTests();
  assert.equal(typeof runtime.aggregateDayStats, 'function');
  assert.equal(typeof runtime.dayMatchesRange, 'function');
  assert.equal(typeof runtime.readSavedView, 'function');
  const storage = {
    value: null,
    getItem() {
      return storage.value;
    },
    setItem(_key, value) {
      storage.value = value;
    },
  };
  runtime.saveView(storage, 'daily');
  assert.equal(runtime.readSavedView(storage), 'daily');
  runtime.saveView(storage, 'bogus');
  assert.equal(runtime.readSavedView(storage), 'session');
  assert.doesNotMatch(timeRangeRuntimeSource(), /\bimport\b|export /u);
});

function runtimeForTests() {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(timeRangeRuntimeSource(), context);
  return context.window.DSH_TIME_RANGE;
}

/* ------------------------------------------------------------------- DOM */

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
    addEventListener() {},
    contains() {
      return true;
    },
  };
  return node;
}

function makeDailyDom(days) {
  const nodes = new Map();
  const rows = [];
  const rangeButtons = [];
  const viewButtons = [];

  const sessions = makeNode();
  sessions.querySelectorAll = () => [];
  nodes.set('sessions', sessions);

  const daily = makeNode();
  days.forEach((day, index) => {
    const target = `day-${index}`;
    const row = makeNode({ 'data-target': target, 'data-day-start': day.dayStart });
    rows.push(row);
    const detail = makeNode({ id: target, 'data-day-start': day.dayStart });
    detail.setAttribute('hidden', '');
    nodes.set(target, detail);
  });
  daily.querySelectorAll = (selector) => (selector === 'tr.day' ? rows : []);
  nodes.set('daily', daily);

  const data = makeNode();
  data.textContent = JSON.stringify({ pageSize: 5, sessions: [], days });
  nodes.set('dsh-cost-data', data);

  for (const id of [
    'stat-cost',
    'stat-cost-note',
    'stat-tokens',
    'stat-tokens-note',
    'stat-cache-read',
    'stat-cache-read-note',
    'stat-cache-saving',
    'model-summary-body',
    'daily-empty',
  ]) {
    nodes.set(id, makeNode(id === 'daily-empty' ? { hidden: '' } : {}));
  }

  const note = makeNode();
  const flag = makeNode({ hidden: '' });
  for (const range of ['all', '30d', '7d', 'today']) {
    const button = makeNode({ 'data-range': range, 'aria-pressed': range === 'all' ? 'true' : 'false' });
    if (range === 'all') button.classList.add('active');
    rangeButtons.push(button);
  }
  for (const view of ['session', 'daily']) {
    const button = makeNode({ 'data-view': view, 'aria-pressed': view === 'session' ? 'true' : 'false' });
    if (view === 'session') button.classList.add('active');
    viewButtons.push(button);
  }

  const doc = {
    getElementById(id) {
      return nodes.get(id) ?? null;
    },
    querySelector(selector) {
      if (selector === '[data-range-note]') return note;
      if (selector === '[data-range-flag]') return flag;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.time-range-selector .range-btn') return rangeButtons;
      if (selector === '.view-selector .view-btn') return viewButtons;
      return [];
    },
  };
  return { doc, rows, nodes, note, flag, rangeButtons, viewButtons };
}