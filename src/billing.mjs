/** Provider-level subscription accounting. Pure functions are also shipped to the browser. */
export function shanghaiDay(time) {
  return Number.isFinite(time) && time > 0 ? new Date(time + 28800000).toISOString().slice(0, 10) : null;
}

/** YYYY-MM-DD that names a real calendar day. */
function isCalendarDay(value) {
  return typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}

function dayTime(day) { return Date.parse(day + 'T00:00:00Z'); }

/** Add whole UTC days; the Shanghai calendar day never shifts with the host zone. */
function shiftDay(day, delta) {
  return new Date(dayTime(day) + delta * 86400000).toISOString().slice(0, 10);
}

/**
 * Natural period end: the same day next month, clamped to that month's last day
 * (2026-01-31 -> 2026-02-28, 2028-01-31 -> 2028-02-29).
 */
function nextMonthSameDay(day) {
  const time = new Date(dayTime(day));
  const year = time.getUTCFullYear();
  const month = time.getUTCMonth() + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const lastDay = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
  return new Date(Date.UTC(nextYear, nextMonth - 1, Math.min(time.getUTCDate(), lastDay))).toISOString().slice(0, 10);
}

/**
 * One explicit record is one payment covering [start, end] inclusive. A later
 * record of the SAME provider that starts on or before the natural end truncates
 * the older period to the day before, so a renewed day belongs to the new period
 * only and an early renewal never double-charges. Nothing renews implicitly:
 * without a later record the period simply ends and the following days are free.
 */
export function billingPeriods(history) {
  const periods = [];
  for (let index = 0; index < history.length; index += 1) {
    const start = history[index].effectiveFrom;
    const next = index + 1 < history.length ? history[index + 1].effectiveFrom : null;
    const naturalEnd = nextMonthSameDay(start);
    const end = next !== null && next <= naturalEnd ? shiftDay(next, -1) : naturalEnd;
    periods.push({ start, end, monthlyUsd: history[index].monthlyUsd, naturalEnd, days: Math.round((dayTime(end) - dayTime(start)) / 86400000) + 1 });
  }
  return periods;
}

/**
 * Micro-USD for one day of a period. The cumulative difference makes a whole
 * period add up to the amount paid exactly, so the UI's display rounding can
 * never decide a total.
 */
function periodDayMicro(period, dayIndex) {
  const micro = Math.round(period.monthlyUsd * 1000000);
  return Math.round(micro * dayIndex / period.days) - Math.round(micro * (dayIndex - 1) / period.days);
}

export function normalizeBilling(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid billing configuration');
  const mode = value.mode ?? 'usage';
  if (!['usage', 'real'].includes(mode)) throw new Error('Invalid billing mode');
  if (value.timeZone !== undefined && value.timeZone !== 'Asia/Shanghai') throw new Error('Billing time zone must be Asia/Shanghai');
  const subscriptions = {};
  for (const provider of ['opencode', 'codex']) {
    const history = value.subscriptions?.[provider] ?? [];
    if (!Array.isArray(history) || history.length > 200) throw new Error('Invalid subscription history: ' + provider);
    const seen = new Set();
    subscriptions[provider] = history.map((entry) => {
      const date = entry?.effectiveFrom;
      if (!isCalendarDay(date)) throw new Error('Invalid effective date: ' + provider);
      if (seen.has(date)) throw new Error('Duplicate effective date: ' + provider);
      seen.add(date);
      const amount = entry.monthlyUsd;
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1000000 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.00001) throw new Error('Monthly USD must be a non-negative amount with at most two decimals');
      return { effectiveFrom: date, monthlyUsd: Math.round(amount * 100) / 100 };
    }).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    // Each record is one payment: every calendar day may start a period, so a
    // mid-month renewal is valid. Same price renewals are ordinary records.
    if (mode === 'real' && subscriptions[provider].length === 0) throw new Error('Configure both subscriptions (use 0 for no subscription)');
  }
  return { version: 1, mode, timeZone: 'Asia/Shanghai', subscriptions };
}

/** Input rows are provider/day usage, not invoice overlays. Costs never flow to models. */
export function subscriptionReport(usage, config, options = {}) {
  const now = options.now ?? Date.now();
  const today = shanghaiDay(now);
  if (!today) throw new Error('Invalid report time');
  const range = ['all', '30d', '7d', 'today'].includes(options.range) ? options.range : 'all';
  for (const value of [options.since, options.until]) {
    if (value !== undefined && value !== null && (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value)) throw new Error('Invalid billing date bound');
  }
  let from = options.since ?? null;
  let until = options.until && options.until < today ? options.until : today;
  if (from && from > until) throw new Error('Billing start must not follow end');
  if (range !== 'all') {
    const count = range === 'today' ? 1 : range === '7d' ? 7 : 30;
    const cutoff = new Date(Date.parse(today + 'T00:00:00Z') - (count - 1) * 86400000).toISOString().slice(0, 10);
    if (!from || cutoff > from) from = cutoff;
  }
  const empty = () => ({ uncachedInputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 0 });
  const sumTokens = (dest, src) => {
    for (const key of ['uncachedInputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens']) dest[key] += src?.[key] ?? 0;
    dest.totalTokens = dest.uncachedInputTokens + dest.outputTokens + dest.cacheWriteTokens + dest.cacheReadTokens;
  };
  const historyOf = (provider) => [...(config.subscriptions?.[provider] ?? [])].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const histories = { opencode: historyOf('opencode'), codex: historyOf('codex') };
  const days = new Map();
  const rowFor = (day, provider) => {
    if (!days.has(day)) days.set(day, { day, providers: new Map() });
    const providers = days.get(day).providers;
    if (!providers.has(provider)) providers.set(provider, { provider, tokens: empty(), costMicroCny: 0, costMicroUsd: 0, usdTokens: 0, cnyTokens: 0, idleMicroUsd: 0, configured: true, subscription: ['opencode', 'codex'].includes(provider), sessions: new Set() });
    return providers.get(provider);
  };
  let unknownTimeTokens = 0;
  for (const item of usage ?? []) {
    if (!item.day) {
      unknownTimeTokens += item.tokens?.totalTokens ?? 0;
      continue;
    }
    if ((from && item.day < from) || item.day > until) continue;
    const row = rowFor(item.day, item.provider);
    sumTokens(row.tokens, item.tokens);
    for (const id of item.sessionIds ?? []) row.sessions.add(id);
    if (row.subscription) {
      const history = histories[item.provider] ?? [];
      row.configured = history.length > 0 && history[0].effectiveFrom <= item.day;
      if (row.configured) row.usdTokens += item.tokens.totalTokens;
    } else {
      row.costMicroCny += item.costMicroCny ?? 0;
      row.costMicroUsd += item.costMicroUsd ?? 0;
      row.cnyTokens += item.cnyTokens ?? 0;
      row.usdTokens += item.usdTokens ?? 0;
    }
  }
  // A period's daily share is amount / its own covered days: the denominator is
  // the full period, never the filtered window or the partially elapsed month.
  for (const provider of ['opencode', 'codex']) {
    const history = histories[provider];
    if (!history.length) continue;
    for (const period of billingPeriods(history)) {
      const start = from && from > period.start ? from : period.start;
      const end = period.end < until ? period.end : until;
      if (start > end) continue;
      const base = dayTime(period.start);
      for (let cursor = dayTime(start); cursor <= dayTime(end); cursor += 86400000) {
        const day = new Date(cursor).toISOString().slice(0, 10);
        const cost = periodDayMicro(period, Math.round((cursor - base) / 86400000) + 1);
        const row = rowFor(day, provider);
        row.costMicroUsd += cost;
        row.monthlyUsd = period.monthlyUsd;
        row.effectiveFrom = period.start;
        row.configured = true;
        if (row.tokens.totalTokens === 0) row.idleMicroUsd += cost;
      }
    }
  }
  const finish = (row) => ({ ...row, sessions: row.sessions.size, costCny: row.costMicroCny / 1000000, costUsd: row.costMicroUsd / 1000000, tokenPrice: { cnyTokens: row.cnyTokens, usdTokens: row.usdTokens, cnyMicroPerM: row.cnyTokens ? Math.round(row.costMicroCny * 1000000 / row.cnyTokens) : null, usdMicroPerM: row.configured && row.usdTokens ? Math.round(row.costMicroUsd * 1000000 / row.usdTokens) : null } });
  const providerTotals = new Map();
  const daily = [...days.values()].sort((a, b) => b.day.localeCompare(a.day)).map((day) => {
    let costMicroCny = 0, costMicroUsd = 0, idleMicroUsd = 0;
    const tokens = empty();
    const providers = [...day.providers.values()].map((row) => {
      if (!providerTotals.has(row.provider)) providerTotals.set(row.provider, { ...row, tokens: empty(), costMicroCny: 0, costMicroUsd: 0, idleMicroUsd: 0, usdTokens: 0, cnyTokens: 0, sessions: new Set(), configured: true, days: 0 });
      const total = providerTotals.get(row.provider);
      sumTokens(total.tokens, row.tokens);
      for (const key of ['costMicroCny', 'costMicroUsd', 'idleMicroUsd', 'usdTokens', 'cnyTokens']) total[key] += row[key];
      for (const id of row.sessions) total.sessions.add(id);
      total.configured = total.configured && row.configured;
      total.days += 1;
      costMicroCny += row.costMicroCny;
      costMicroUsd += row.costMicroUsd;
      idleMicroUsd += row.idleMicroUsd;
      sumTokens(tokens, row.tokens);
      return finish(row);
    });
    return { day: day.day, tokens, costMicroCny, costMicroUsd, idleMicroUsd, providers };
  });
  const providers = [...providerTotals.values()].sort((a, b) => a.provider.localeCompare(b.provider)).map(finish);
  const summary = { tokens: empty(), costMicroCny: 0, costMicroUsd: 0, idleMicroUsd: 0, cnyTokens: 0, usdTokens: 0, sessions: new Set(), days: daily.length, configured: true };
  for (const total of providerTotals.values()) {
    sumTokens(summary.tokens, total.tokens);
    for (const key of ['costMicroCny', 'costMicroUsd', 'idleMicroUsd', 'usdTokens', 'cnyTokens']) summary[key] += total[key];
    for (const id of total.sessions) summary.sessions.add(id);
    summary.configured = summary.configured && total.configured;
  }
  const result = finish(summary);
  const input = result.tokens.uncachedInputTokens + result.tokens.cacheWriteTokens + result.tokens.cacheReadTokens;
  return { mode: 'real', timeZone: 'Asia/Shanghai', from, until, range, unknownTimeTokens, modelCostsAllocated: false, sessionCostsAllocated: false, summary: { ...result, inputTokens: result.tokens.uncachedInputTokens, outputTokens: result.tokens.outputTokens, cacheWriteTokens: result.tokens.cacheWriteTokens, cacheReadTokens: result.tokens.cacheReadTokens, totalTokens: result.tokens.totalTokens, cacheHit: input ? result.tokens.cacheReadTokens / input : null, pricedSessions: 0, unpricedModels: [], pendingSessions: 0, pendingModels: [] }, providers, days: daily };
}

export function billingRuntimeSource() {
  return [shanghaiDay, dayTime, shiftDay, nextMonthSameDay, billingPeriods, periodDayMicro, subscriptionReport].map((fn) => fn.toString()).join('\n') + '\nwindow.DSH_BILLING = { shanghaiDay: shanghaiDay, periods: billingPeriods, calculate: subscriptionReport };';
}
