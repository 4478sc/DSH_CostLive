/**
 * Time-range filtering for the HTML report and the live dashboard.
 *
 * Everything in this module runs twice:
 *   1. in Node (unit tests, `renderHtml`);
 *   2. in the browser, because `timeRangeRuntimeSource()` serializes the same
 *      function sources into the report's inline `<script>`.
 *
 * The pure functions are therefore self-contained: no imports, no module-level
 * helpers beyond the constants injected by `timeRangeRuntimeSource()`, and no
 * `this`/`process`/`fs` references. Editing one of them changes both surfaces.
 */
import { formatPercent } from './format.mjs';
import { formatCny, formatTokens } from './pricing.mjs';

/** One day in milliseconds; `7d`/`30d` are rolling windows ending at `now`. */
export const DAY_MS = 86_400_000;

/** Selector order as rendered: all time (default), then the windows. */
export const TIME_RANGES = Object.freeze(['all', '30d', '7d', 'today']);

/** localStorage key used by the static report and the live client. */
export const TIME_RANGE_STORAGE_KEY = 'dsh-cost-time-range';

/** View modes: per-session accounting (default) and per-day sample accounting. */
export const VIEW_MODES = Object.freeze(['session', 'daily']);

/** localStorage key for the selected view mode. */
export const VIEW_STORAGE_KEY = 'dsh-cost-view';

/** Local midnight of the day containing `now` (the user's own time zone). */
export function localMidnight(now) {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Local midnight `deltaDays` calendar days away from `dayStart`. */
export function shiftLocalDay(dayStart, deltaDays) {
  const date = new Date(dayStart);
  date.setDate(date.getDate() + deltaDays);
  return date.getTime();
}

/**
 * Inclusive lower bound for the DAILY view. Daily buckets cannot be split, so
 * these windows are calendar days: `today` is today, `7d` is today plus the six
 * previous local days, `30d` is today plus the previous 29. `all` returns 0.
 */
export function rangeDayCutoff(range, now) {
  const normalized = normalizeTimeRange(range);
  if (normalized === 'all') return 0;
  const current = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  const today = localMidnight(current);
  if (normalized === 'today') return today;
  if (normalized === '7d') return shiftLocalDay(today, -6);
  if (normalized === '30d') return shiftLocalDay(today, -29);
  return 0;
}

/**
 * Whether a daily bucket belongs to `range`.
 *
 * Buckets without a usable timestamp (`dayStart` 0) only appear under `all`:
 * they cannot be placed on a calendar day. All-time therefore still shows all
 * spend, while the dated windows stay honest.
 */
export function dayMatchesRange(dayStart, range, now) {
  const normalized = normalizeTimeRange(range);
  if (normalized === 'all') return true;
  if (typeof dayStart !== 'number' || !Number.isFinite(dayStart) || dayStart <= 0) return false;
  return dayStart >= rangeDayCutoff(normalized, now);
}

/**
 * Inclusive lower bound (Unix ms) for one range.
 *
 * `today` starts at local midnight, so it follows the user's time zone rather
 * than UTC. `7d` / `30d` are rolling windows measured from `now`; `all` and any
 * unknown value return 0 so nothing is excluded.
 */
export function rangeCutoff(range, now) {
  const current = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  if (range === 'today') return localMidnight(current);
  if (range === '7d') return current - 7 * DAY_MS;
  if (range === '30d') return current - 30 * DAY_MS;
  return 0;
}

/** Clamp a stored/clicked value to a known range (`all` on anything else). */
export function normalizeTimeRange(value) {
  for (let index = 0; index < TIME_RANGES.length; index += 1) {
    if (TIME_RANGES[index] === value) return value;
  }
  return 'all';
}

/**
 * Whether a session creation time falls in `range`.
 *
 * A missing / invalid `createdAt` is kept: an undated session cannot be placed
 * in a window, and silently dropping it would hide real spend. This matches the
 * report's "render everything, filter only what we can date" contract.
 */
export function sessionMatchesRange(createdAt, range, now) {
  const normalized = normalizeTimeRange(range);
  if (normalized === 'all') return true;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) return true;
  return createdAt >= rangeCutoff(normalized, now);
}

/** Filter session records by range, preserving the caller's order. */
export function filterSessionsByRange(sessions, range, now) {
  const normalized = normalizeTimeRange(range);
  const list = Array.isArray(sessions) ? sessions : [];
  const out = [];
  for (let index = 0; index < list.length; index += 1) {
    const session = list[index];
    if (sessionMatchesRange(session === null || session === undefined ? null : session.createdAt, normalized, now)) {
      out.push(session);
    }
  }
  return out;
}

/** Local `YYYY-MM-DD` for range captions. */
export function formatDay(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  const date = new Date(ms);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${date.getFullYear()}-${month < 10 ? '0' : ''}${month}-${day < 10 ? '0' : ''}${day}`;
}

/** Human caption for one range, e.g. "最近 7 天（2026-10-18 起）". */
export function formatRangeLabel(range, now) {
  const normalized = normalizeTimeRange(range);
  const current = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  if (normalized === 'today') return `今天（${formatDay(current)}）`;
  if (normalized === '7d') return `最近 7 天（${formatDay(current - 7 * DAY_MS)} 起）`;
  if (normalized === '30d') return `最近 30 天（${formatDay(current - 30 * DAY_MS)} 起）`;
  return '全部时间';
}

/** Caption for the daily view: calendar days, not rolling 24h windows. */
export function formatDailyRangeLabel(range, now) {
  const normalized = normalizeTimeRange(range);
  const current = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  if (normalized === 'today') return `今天（${formatDay(current)}）`;
  if (normalized === '7d') {
    return `最近 7 天（${formatDay(shiftLocalDay(localMidnight(current), -6))} 至 ${formatDay(current)}）`;
  }
  if (normalized === '30d') {
    return `最近 30 天（${formatDay(shiftLocalDay(localMidnight(current), -29))} 至 ${formatDay(current)}）`;
  }
  return '全部时间（按天）';
}

/** Zero token buckets (same shape as the report's per-model token records). */
export function zeroTokens() {
  return { uncachedInputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
}

/**
 * Recompute the summary cards and the per-model table for a set of sessions.
 *
 * Mirrors `buildReport()`'s summary arithmetic, including the 4-decimal
 * `cacheHit` rounding, so the default "All time" view produces exactly the
 * server-rendered numbers. Returns a flat totals record plus `models`.
 */
export function aggregateRangeStats(sessions) {
  const totals = {
    sessions: 0,
    pricedSessions: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costMicroCny: 0,
    cacheSavingMicro: 0,
    cacheHit: null,
    models: [],
  };
  const map = new Map();
  const list = Array.isArray(sessions) ? sessions : [];
  for (let index = 0; index < list.length; index += 1) {
    const session = list[index] ?? {};
    const tokens = session.tokens ?? {};
    totals.sessions += 1;
    if ((session.costMicroCny || 0) > 0) totals.pricedSessions += 1;
    totals.uncachedInputTokens += tokens.uncachedInputTokens || 0;
    totals.outputTokens += tokens.outputTokens || 0;
    totals.cacheWriteTokens += tokens.cacheWriteTokens || 0;
    totals.cacheReadTokens += tokens.cacheReadTokens || 0;
    totals.totalTokens += tokens.totalTokens || 0;
    totals.costMicroCny += session.costMicroCny || 0;
    totals.cacheSavingMicro += session.cacheSavingMicro || 0;

    const models = Array.isArray(session.models) ? session.models : [];
    for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
      const model = models[modelIndex] ?? {};
      const key = `${model.provider ?? '?'}\u0000${model.model ?? '?'}`;
      let entry = map.get(key);
      if (entry === undefined) {
        entry = {
          provider: model.provider ?? null,
          model: model.model ?? null,
          priced: model.priced === true,
          tokens: zeroTokens(),
          costMicroCny: 0,
          sessions: 0,
        };
        map.set(key, entry);
      }
      const modelTokens = model.tokens ?? {};
      entry.tokens.uncachedInputTokens += modelTokens.uncachedInputTokens || 0;
      entry.tokens.outputTokens += modelTokens.outputTokens || 0;
      entry.tokens.cacheWriteTokens += modelTokens.cacheWriteTokens || 0;
      entry.tokens.cacheReadTokens += modelTokens.cacheReadTokens || 0;
      entry.costMicroCny += model.costMicroCny || 0;
      entry.sessions += 1;
    }
  }
  const billedInput = totals.uncachedInputTokens + totals.cacheWriteTokens + totals.cacheReadTokens;
  totals.cacheHit = billedInput === 0 ? null : Math.round((totals.cacheReadTokens / billedInput) * 10000) / 10000;
  totals.models = [...map.values()].sort((a, b) => b.costMicroCny - a.costMicroCny);
  return totals;
}

/** Clamp a stored/clicked view value to a known mode (`session` on anything else). */
export function normalizeView(value) {
  for (let index = 0; index < VIEW_MODES.length; index += 1) {
    if (VIEW_MODES[index] === value) return value;
  }
  return 'session';
}

/**
 * Aggregate daily buckets into the same shape `aggregateRangeStats` returns, so
 * the cards and the per-model table can be rendered by the same code.
 *
 * `sessions` / `pricedSessions` count DISTINCT session ids across the selected
 * days; a session that ran past midnight appears once per day bucket but is
 * still one session here. Model rows count the distinct sessions that used the
 * model, not day-session pairs.
 */
export function aggregateDayStats(days) {
  const totals = {
    days: 0,
    sessions: 0,
    pricedSessions: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costMicroCny: 0,
    cacheSavingMicro: 0,
    samples: 0,
    cacheHit: null,
    models: [],
  };
  const modelMap = new Map();
  const sessionSeen = Object.create(null);
  const sessionCost = Object.create(null);
  const list = Array.isArray(days) ? days : [];

  for (let index = 0; index < list.length; index += 1) {
    const day = list[index] ?? {};
    const dayTotals = day.totals ?? {};
    totals.days += 1;
    totals.uncachedInputTokens += dayTotals.uncachedInputTokens || 0;
    totals.outputTokens += dayTotals.outputTokens || 0;
    totals.cacheWriteTokens += dayTotals.cacheWriteTokens || 0;
    totals.cacheReadTokens += dayTotals.cacheReadTokens || 0;
    totals.totalTokens += dayTotals.totalTokens || 0;
    totals.costMicroCny += dayTotals.costMicroCny || 0;
    totals.cacheSavingMicro += dayTotals.cacheSavingMicro || 0;
    totals.samples += dayTotals.samples || 0;

    const daySessions = Array.isArray(day.sessions) ? day.sessions : [];
    for (let sessionIndex = 0; sessionIndex < daySessions.length; sessionIndex += 1) {
      const session = daySessions[sessionIndex] ?? {};
      const sessionId = session.uid || session.id || `?${sessionIndex}`;
      sessionSeen[sessionId] = true;
      sessionCost[sessionId] = (sessionCost[sessionId] || 0) + (session.costMicroCny || 0);

      const models = Array.isArray(session.models) ? session.models : [];
      for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
        const model = models[modelIndex] ?? {};
        const key = `${model.provider ?? '?'}\u0000${model.model ?? '?'}`;
        let entry = modelMap.get(key);
        if (entry === undefined) {
          entry = {
            provider: model.provider ?? null,
            model: model.model ?? null,
            priced: model.priced === true,
            tokens: zeroTokens(),
            costMicroCny: 0,
            cacheSavingMicro: 0,
            sessionIds: Object.create(null),
          };
          modelMap.set(key, entry);
        }
        const modelTokens = model.tokens ?? {};
        entry.tokens.uncachedInputTokens += modelTokens.uncachedInputTokens || 0;
        entry.tokens.outputTokens += modelTokens.outputTokens || 0;
        entry.tokens.cacheWriteTokens += modelTokens.cacheWriteTokens || 0;
        entry.tokens.cacheReadTokens += modelTokens.cacheReadTokens || 0;
        entry.costMicroCny += model.costMicroCny || 0;
        entry.cacheSavingMicro += model.cacheSavingMicro || 0;
        entry.sessionIds[sessionId] = true;
      }
    }
  }

  totals.sessions = Object.keys(sessionSeen).length;
  for (const id of Object.keys(sessionCost)) {
    if (sessionCost[id] > 0) totals.pricedSessions += 1;
  }
  const billedInput = totals.uncachedInputTokens + totals.cacheWriteTokens + totals.cacheReadTokens;
  totals.cacheHit = billedInput === 0 ? null : Math.round((totals.cacheReadTokens / billedInput) * 10000) / 10000;
  totals.models = [...modelMap.values()]
    .map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      priced: entry.priced,
      tokens: entry.tokens,
      costMicroCny: entry.costMicroCny,
      cacheSavingMicro: entry.cacheSavingMicro,
      sessions: Object.keys(entry.sessionIds).length,
    }))
    .sort((a, b) => b.costMicroCny - a.costMicroCny);
  return totals;
}

/**
 * Browser-only DOM layer. Kept as source text so it is embedded next to the
 * serialized pure functions (one runtime for report + live page).
 */
const DOM_SOURCE = `function readDataset(doc) {
  var node = doc.getElementById('dsh-cost-data');
  if (!node) return null;
  try {
    var parsed = JSON.parse(node.textContent || 'null');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    return null;
  }
}

function parseStamp(value) {
  var number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (char) {
    if (char === '&') return '&amp;';
    if (char === '<') return '&lt;';
    if (char === '>') return '&gt;';
    if (char === '"') return '&quot;';
    return '&#39;';
  });
}

function setText(node, text) {
  if (node) node.textContent = text;
}

function renderModelTable(doc, models) {
  var body = doc.getElementById('model-summary-body');
  if (!body) return;
  if (!models || models.length === 0) {
    body.innerHTML = '<tr><td colspan="8" class="muted" style="padding:20px">没有用量记录</td></tr>';
    return;
  }
  var html = '';
  for (var index = 0; index < models.length; index += 1) {
    var model = models[index];
    var tokens = model.tokens || {};
    html += '<tr>' +
      '<td class="mono">' + escapeHtml(model.model === null || model.model === undefined ? 'unknown' : model.model) + '</td>' +
      '<td class="muted">' + escapeHtml(model.provider === null || model.provider === undefined ? '—' : model.provider) + '</td>' +
      '<td class="num">' + formatTokens(tokens.uncachedInputTokens || 0) + '</td>' +
      '<td class="num">' + formatTokens(tokens.outputTokens || 0) + '</td>' +
      '<td class="num">' + formatTokens(tokens.cacheWriteTokens || 0) + '</td>' +
      '<td class="num">' + formatTokens(tokens.cacheReadTokens || 0) + '</td>' +
      '<td class="num strong">' + (model.priced ? formatCny(model.costMicroCny / 1e6) : '未定价') + '</td>' +
      '<td class="num muted">' + model.sessions + '</td>' +
      '</tr>';
  }
  body.innerHTML = html;
}

function setViewButtons(doc, view) {
  var buttons = doc.querySelectorAll('.view-selector .view-btn');
  for (var index = 0; index < buttons.length; index += 1) {
    var button = buttons[index];
    var active = normalizeView(button.getAttribute('data-view')) === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

function readSavedView(storage) {
  try {
    if (!storage) return 'session';
    return normalizeView(storage.getItem(VIEW_KEY));
  } catch (error) {
    return 'session';
  }
}

function saveView(storage, view) {
  try {
    if (storage) storage.setItem(VIEW_KEY, normalizeView(view));
  } catch (error) {
    /* private mode / file:// storage disabled: switching still works */
  }
}

function bindViewSelector(doc, onChange) {
  var bar = doc.querySelector('.view-selector');
  if (!bar) return;
  bar.addEventListener('click', function (event) {
    var target = event.target;
    var button = target && target.closest ? target.closest('.view-btn') : null;
    if (!button || !bar.contains(button)) return;
    event.preventDefault();
    if (typeof onChange === 'function') onChange(normalizeView(button.getAttribute('data-view')));
  });
}

/**
 * Daily view: each bucket is one local calendar day, aggregated from sample
 * timestamps. A session that ran past midnight appears under both days with
 * only that day's share, so the cards answer "how much was spent in this
 * window" rather than "what did the sessions created in this window cost".
 */
function applyDailyView(doc, range, now, days) {
  var sessionsSection = doc.getElementById('sessions');
  if (sessionsSection) sessionsSection.setAttribute('hidden', '');
  var dailySection = doc.getElementById('daily');
  if (dailySection) dailySection.removeAttribute('hidden');

  var rows = dailySection ? dailySection.querySelectorAll('tr.day') : [];
  var kept = 0;
  for (var rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    var row = rows[rowIndex];
    var detail = doc.getElementById(row.getAttribute('data-target') || '');
    if (!dayMatchesRange(parseStamp(row.getAttribute('data-day-start')), range, now)) {
      row.setAttribute('data-range-hidden', '1');
      row.setAttribute('hidden', '');
      if (detail) {
        detail.setAttribute('hidden', '');
        detail.classList.remove('open');
      }
      continue;
    }
    kept += 1;
    row.removeAttribute('data-range-hidden');
    row.removeAttribute('hidden');
    if (detail) detail.removeAttribute('hidden');
  }

  var filtered = [];
  for (var dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
    if (dayMatchesRange(days[dayIndex].dayStart, range, now)) filtered.push(days[dayIndex]);
  }
  var stats = aggregateDayStats(filtered);

  setText(doc.getElementById('stat-cost'), formatCny(stats.costMicroCny / 1e6));
  setText(doc.getElementById('stat-cost-note'), stats.sessions + ' 个会话 · ' + stats.days + ' 天（按采样）');
  setText(doc.getElementById('stat-tokens'), formatTokens(stats.totalTokens));
  setText(doc.getElementById('stat-tokens-note'), 'in ' + formatTokens(stats.uncachedInputTokens) + ' · out ' + formatTokens(stats.outputTokens));
  setText(doc.getElementById('stat-cache-read'), formatTokens(stats.cacheReadTokens));
  setText(doc.getElementById('stat-cache-read-note'), '占计费输入 ' + formatPercent(stats.cacheHit));
  setText(doc.getElementById('stat-cache-saving'), formatCny(stats.cacheSavingMicro / 1e6));
  renderModelTable(doc, stats.models);

  var empty = doc.getElementById('daily-empty');
  if (empty) {
    if (kept === 0) empty.removeAttribute('hidden');
    else empty.setAttribute('hidden', '');
  }

  var note = doc.querySelector('[data-range-note]');
  if (note) {
    note.textContent = formatDailyRangeLabel(range, now) + ' · ' + stats.sessions + ' 个会话 / ' + stats.days + ' 天';
  }
  var flag = doc.querySelector('[data-range-flag]');
  if (flag) {
    if (range === 'all') flag.setAttribute('hidden', '');
    else flag.removeAttribute('hidden');
  }
  var bar = doc.getElementById('dsh-cost-range');
  if (bar) bar.setAttribute('data-filtered', range === 'all' ? 'false' : 'true');

  var buttons = doc.querySelectorAll('.time-range-selector .range-btn');
  for (var buttonIndex = 0; buttonIndex < buttons.length; buttonIndex += 1) {
    var button = buttons[buttonIndex];
    var active = normalizeTimeRange(button.getAttribute('data-range')) === range;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  setViewButtons(doc, 'daily');

  return { range: range, view: 'daily', kept: kept, total: rows.length, days: stats.days, stats: stats };
}

/**
 * Apply one range to the document: hide out-of-range rows, re-page the
 * survivors, refresh the cards + model table, and move the active pill.
 * Safe to call repeatedly (live fragment swaps, show-more toggles).
 */
function applyTimeRange(doc, options) {
  options = options || {};
  var range = normalizeTimeRange(options.range);
  var view = normalizeView(options.view);
  var showAll = options.showAll === true;
  var now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now();
  var data = readDataset(doc);
  var allSessions = data && Array.isArray(data.sessions) ? data.sessions : null;
  var dailyDays = data && Array.isArray(data.days) ? data.days : [];
  var pageSize = data && typeof data.pageSize === 'number' && data.pageSize > 0 ? data.pageSize : 5;
  if (view === 'daily') return applyDailyView(doc, range, now, dailyDays);
  var filtered = allSessions === null ? null : filterSessionsByRange(allSessions, range, now);
  var visible = Object.create(null);
  if (filtered !== null) {
    for (var index = 0; index < filtered.length; index += 1) {
      visible[filtered[index].uid || filtered[index].id] = true;
    }
  }

  var section = doc.getElementById('sessions');
  var rows = section ? section.querySelectorAll('tr.session') : [];
  var kept = 0;
  var total = allSessions === null ? rows.length : allSessions.length;

  for (var rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    var row = rows[rowIndex];
    var id = row.getAttribute('data-session');
    var detail = doc.getElementById(row.getAttribute('data-target') || '');
    var inRange;
    if (filtered !== null) inRange = visible[id] === true;
    else inRange = sessionMatchesRange(parseStamp(row.getAttribute('data-created-at')), range, now);
    if (!inRange) {
      row.setAttribute('data-range-hidden', '1');
      row.setAttribute('hidden', '');
      if (detail) {
        detail.setAttribute('hidden', '');
        detail.classList.remove('open');
      }
      continue;
    }
    kept += 1;
    row.removeAttribute('data-range-hidden');
    var extra = kept > pageSize;
    row.classList.toggle('session-extra', extra);
    if (detail) detail.classList.toggle('session-extra', extra);
    if (extra && !showAll) {
      row.setAttribute('hidden', '');
      if (detail) {
        detail.setAttribute('hidden', '');
        detail.classList.remove('open');
      }
    } else {
      row.removeAttribute('hidden');
      if (detail) detail.removeAttribute('hidden');
    }
  }

  var stats = filtered === null ? null : aggregateRangeStats(filtered);
  if (stats !== null) {
    setText(doc.getElementById('stat-cost'), formatCny(stats.costMicroCny / 1e6));
    setText(doc.getElementById('stat-cost-note'), stats.pricedSessions + ' / ' + stats.sessions + ' 个会话产生费用');
    setText(doc.getElementById('stat-tokens'), formatTokens(stats.totalTokens));
    setText(doc.getElementById('stat-tokens-note'), 'in ' + formatTokens(stats.uncachedInputTokens) + ' · out ' + formatTokens(stats.outputTokens));
    setText(doc.getElementById('stat-cache-read'), formatTokens(stats.cacheReadTokens));
    setText(doc.getElementById('stat-cache-read-note'), '占计费输入 ' + formatPercent(stats.cacheHit));
    setText(doc.getElementById('stat-cache-saving'), formatCny(stats.cacheSavingMicro / 1e6));
    renderModelTable(doc, stats.models);
  }

  var empty = doc.getElementById('sessions-empty');
  if (empty) {
    if (kept === 0) empty.removeAttribute('hidden');
    else empty.setAttribute('hidden', '');
  }

  var extraCount = Math.max(0, kept - pageSize);
  var more = doc.querySelector('[data-sessions-more]');
  if (more) {
    if (extraCount === 0) more.setAttribute('hidden', '');
    else more.removeAttribute('hidden');
    var toggle = doc.querySelector('[data-sessions-toggle]');
    if (toggle) {
      var moreLabel = extraCount > 0 ? '显示更多（还有 ' + extraCount + ' 个）' : '显示更多';
      toggle.setAttribute('data-more-label', moreLabel);
      toggle.textContent = showAll && extraCount > 0 ? '收起' : moreLabel;
      toggle.setAttribute('aria-expanded', showAll && extraCount > 0 ? 'true' : 'false');
    }
  }

  var note = doc.querySelector('[data-range-note]');
  if (note) {
    note.textContent = formatRangeLabel(range, now) + ' · ' + kept + (range === 'all' ? ' 个会话' : ' / ' + total + ' 个会话');
  }
  var flag = doc.querySelector('[data-range-flag]');
  if (flag) {
    if (range === 'all') flag.setAttribute('hidden', '');
    else flag.removeAttribute('hidden');
  }
  var bar = doc.getElementById('dsh-cost-range');
  if (bar) bar.setAttribute('data-filtered', range === 'all' ? 'false' : 'true');

  var buttons = doc.querySelectorAll('.time-range-selector .range-btn');
  for (var buttonIndex = 0; buttonIndex < buttons.length; buttonIndex += 1) {
    var button = buttons[buttonIndex];
    var active = normalizeTimeRange(button.getAttribute('data-range')) === range;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  var dailySection = doc.getElementById('daily');
  if (dailySection) dailySection.setAttribute('hidden', '');
  var sessionsSection = doc.getElementById('sessions');
  if (sessionsSection) sessionsSection.removeAttribute('hidden');
  setViewButtons(doc, 'session');

  return { range: range, view: 'session', kept: kept, total: total, extra: extraCount, stats: stats };
}

function readSavedRange(storage) {
  try {
    if (!storage) return 'all';
    return normalizeTimeRange(storage.getItem(STORAGE_KEY));
  } catch (error) {
    return 'all';
  }
}

function saveRange(storage, range) {
  try {
    if (storage) storage.setItem(STORAGE_KEY, normalizeTimeRange(range));
  } catch (error) {
    /* private mode / file:// storage disabled: filtering still works */
  }
}

function bindRangeSelector(doc, onChange) {
  var bar = doc.getElementById('dsh-cost-range');
  if (!bar) return;
  bar.addEventListener('click', function (event) {
    var target = event.target;
    var button = target && target.closest ? target.closest('.range-btn') : null;
    if (!button || !bar.contains(button)) return;
    event.preventDefault();
    if (typeof onChange === 'function') onChange(normalizeTimeRange(button.getAttribute('data-range')));
  });
}`;

/** Indent serialized function source so the generated runtime stays readable. */
function indentSource(source) {
  return source
    .split('\n')
    .map((line) => (line === '' ? '' : `  ${line}`))
    .join('\n');
}

/**
 * Build the browser runtime source: the serialized pure functions plus the DOM
 * layer, exposed as `window.DSH_TIME_RANGE`. The report and the live page both
 * embed this exact string, so the filtering rules can never drift apart.
 */
export function timeRangeRuntimeSource() {
  const pure = [
    localMidnight,
    shiftLocalDay,
    rangeCutoff,
    rangeDayCutoff,
    normalizeTimeRange,
    normalizeView,
    sessionMatchesRange,
    dayMatchesRange,
    filterSessionsByRange,
    formatDay,
    formatRangeLabel,
    formatDailyRangeLabel,
    zeroTokens,
    aggregateRangeStats,
    aggregateDayStats,
    formatCny,
    formatTokens,
    formatPercent,
  ]
    .map((fn) => indentSource(fn.toString()))
    .join('\n\n');

  return `(function () {
  'use strict';
  var DAY_MS = ${DAY_MS};
  var STORAGE_KEY = ${JSON.stringify(TIME_RANGE_STORAGE_KEY)};
  var VIEW_KEY = ${JSON.stringify(VIEW_STORAGE_KEY)};
  var TIME_RANGES = ${JSON.stringify([...TIME_RANGES])};
  var VIEW_MODES = ${JSON.stringify([...VIEW_MODES])};
  var RANGE_VALUES = TIME_RANGES;

${pure}

${indentSource(DOM_SOURCE)}

  window.DSH_TIME_RANGE = {
    ranges: RANGE_VALUES,
    views: VIEW_MODES,
    storageKey: STORAGE_KEY,
    viewStorageKey: VIEW_KEY,
    dayMs: DAY_MS,
    localMidnight: localMidnight,
    shiftLocalDay: shiftLocalDay,
    rangeCutoff: rangeCutoff,
    rangeDayCutoff: rangeDayCutoff,
    normalizeTimeRange: normalizeTimeRange,
    normalizeView: normalizeView,
    sessionMatchesRange: sessionMatchesRange,
    dayMatchesRange: dayMatchesRange,
    filterSessionsByRange: filterSessionsByRange,
    formatDay: formatDay,
    formatRangeLabel: formatRangeLabel,
    formatDailyRangeLabel: formatDailyRangeLabel,
    aggregateRangeStats: aggregateRangeStats,
    aggregateDayStats: aggregateDayStats,
    applyTimeRange: applyTimeRange,
    readSavedRange: readSavedRange,
    saveRange: saveRange,
    readSavedView: readSavedView,
    saveView: saveView,
    bindRangeSelector: bindRangeSelector,
    bindViewSelector: bindViewSelector
  };
})();`;
}
