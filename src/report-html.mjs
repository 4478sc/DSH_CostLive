/** Self-contained HTML report. */
import { activityLabel, sortSessionRecords } from './activity.mjs';
import { describePeakHours, formatCny, formatTokens } from './pricing.mjs';
import { formatPercent, formatTime } from './format.mjs';
import { buildTimeRangeDataset, modelCacheSavingMicro } from './report-data.mjs';
import { formatDay, formatRangeLabel, timeRangeRuntimeSource } from './time-range.mjs';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Session rows rendered without expanding: running sessions sort into this window first. */
export const SESSION_PAGE_SIZE = 5;

/** HTML-escape one value. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, (char) => ESCAPES[char]);
}

/** Format a CNY number with the same precision rules as the terminal report. */
function cny(micro) {
  return formatCny(micro / 1e6);
}

/** Aggregate per-model totals across all sessions. */
function aggregateModels(sessions, pricing) {
  const map = new Map();
  for (const session of sessions) {
    for (const model of session.models) {
      const key = `${model.provider ?? '?'}\u0000${model.model ?? '?'}`;
      let entry = map.get(key);
      if (entry === undefined) {
        entry = {
          provider: model.provider,
          model: model.model,
          priceKey: model.priceKey,
          priced: model.priced,
          tokens: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costMicroCny: 0,
          cacheSavingMicro: 0,
          sessions: new Set(),
        };
        map.set(key, entry);
      }
      entry.tokens.uncachedInputTokens += model.tokens.uncachedInputTokens;
      entry.tokens.outputTokens += model.tokens.outputTokens;
      entry.tokens.cacheReadTokens += model.tokens.cacheReadTokens;
      entry.tokens.cacheWriteTokens += model.tokens.cacheWriteTokens;
      entry.costMicroCny += model.costMicroCny;
      // Rounded per model so the browser's integer sums reproduce this total.
      entry.cacheSavingMicro += Math.round(modelCacheSavingMicro(model, pricing));
      entry.sessions.add(session.id);
    }
  }
  return [...map.values()].sort((a, b) => b.costMicroCny - a.costMicroCny);
}

/** Render a bar whose width is relative to `max`. */
function bar(value, max, className = '') {
  const width = max <= 0 ? 0 : Math.max(2, Math.round((value / max) * 100));
  return `<div class="bar ${className}" aria-hidden="true"><i style="width:${width}%"></i></div>`;
}

/** Build the complete standalone HTML document. */
export function renderHtml(report) {
  const { summary, pricing } = report;
  // Render from a sorted copy: running main -> running subagent -> completed,
  // with the existing cost/time order preserved inside each bucket. Running
  // sessions therefore always land inside the first SESSION_PAGE_SIZE rows.
  const sessions = sortSessionRecords([...report.sessions]);
  const hiddenCount = Math.max(0, sessions.length - SESSION_PAGE_SIZE);
  const runningCount = sessions.filter((session) => session.running === true).length;
  const maxCost = Math.max(0, ...sessions.map((session) => session.totals.costMicroCny));
  const dailyDays = Array.isArray(report.daily?.days) ? report.daily.days : [];
  const maxDayCost = Math.max(0, ...dailyDays.map((day) => day.totals.costMicroCny));
  const todayKey = formatDay(report.generatedAt);
  const models = aggregateModels(sessions, pricing);
  const billable = summary.inputTokens + summary.cacheWriteTokens + summary.cacheReadTokens;
  const cacheSavingMicro = Math.round(models.reduce((sum, model) => sum + model.cacheSavingMicro, 0));
  const pricedCount = summary.pricedSessions;
  const unpriced = summary.unpricedModels;
  // Every session is serialized into the page; the inline client filters this
  // dataset locally, so one report serves all four time ranges and no-JS still
  // sees the complete server render.
  const datasetJson = JSON.stringify(
    buildTimeRangeDataset({ sessions, daily: report.daily, pricing, pageSize: SESSION_PAGE_SIZE }),
  ).replace(/</gu, '\\u003c');
  const rangeNote = `${formatRangeLabel('all', report.generatedAt)} · ${sessions.length} 个会话`;

  const priceRows = Object.entries(pricing.models)
    .map(
      ([id, price]) => `<tr>
        <td class="mono">${escapeHtml(id)}${price.peak === undefined ? '' : ' <span class="muted">· 谷值</span>'}</td>
        <td class="num">${price.input}</td>
        <td class="num">${price.output}</td>
        <td class="num">${price.cacheWrite}</td>
        <td class="num">${price.cacheRead}</td>
      </tr>`,
    )
    .join('');

  // Two-tier models: the table above lists the default (off-peak) prices, so
  // spell out the peak tier and the hours it applies to.
  const tariffNotes = Object.entries(pricing.models)
    .filter(([, price]) => price.peak !== undefined)
    .map(([id, price]) => {
      const peak = price.peak;
      return `<div class="note">${escapeHtml(id)} 峰值时段：输入 ${peak.input} · 输出 ${peak.output} · 缓存创建 ${peak.cacheWrite} · 缓存读取 ${peak.cacheRead}（${escapeHtml(report.currency)} / 1M）。峰值时段 ${escapeHtml(describePeakHours(price) ?? '')}，其余时间为谷值价。</div>`;
    })
    .join('');

  const modelRows = models
    .map(
      (model) => `<tr>
        <td class="mono">${escapeHtml(model.model ?? 'unknown')}</td>
        <td class="muted">${escapeHtml(model.provider ?? '—')}</td>
        <td class="num">${formatTokens(model.tokens.uncachedInputTokens)}</td>
        <td class="num">${formatTokens(model.tokens.outputTokens)}</td>
        <td class="num">${formatTokens(model.tokens.cacheWriteTokens)}</td>
        <td class="num">${formatTokens(model.tokens.cacheReadTokens)}</td>
        <td class="num strong">${model.priced ? cny(model.costMicroCny) : '未定价'}</td>
        <td class="num muted">${model.sessions.size}</td>
      </tr>`,
    )
    .join('');

  const sessionRows = sessions
    .map((session, index) => {
      const target = `s${index}`;
      const running = session.running === true;
      const subagent = session.isSubagent === true;
      const extra = index >= SESSION_PAGE_SIZE;
      const rowClass = ['session', running ? 'is-running' : '', subagent ? 'is-subagent' : '', extra ? 'session-extra' : '']
        .filter(Boolean)
        .join(' ');
      const detailClass = ['detail', extra ? 'session-extra' : ''].filter(Boolean).join(' ');
      const hiddenAttr = extra ? ' hidden' : '';
      const flags = [
        running ? '<span class="pill pill-run"><i aria-hidden="true"></i>运行中</span>' : '',
        subagent ? '<span class="pill pill-sub">子代理</span>' : '',
      ].join('');
      const modelChips = session.models
        .map(
          (model) =>
            `<span class="chip ${model.priced ? '' : 'chip-warn'}">${escapeHtml(model.model ?? 'unknown')}</span>`,
        )
        .join('');
      const detailModels = session.models
        .map(
          (model) => `<tr>
            <td class="mono">${escapeHtml(model.model ?? 'unknown')}</td>
            <td class="muted">${escapeHtml(model.provider ?? '—')}</td>
            <td class="num">${formatTokens(model.tokens.uncachedInputTokens)}</td>
            <td class="num">${formatTokens(model.tokens.outputTokens)}</td>
            <td class="num">${formatTokens(model.tokens.cacheWriteTokens)}</td>
            <td class="num">${formatTokens(model.tokens.cacheReadTokens)}</td>
            <td class="num strong">${model.priced ? cny(model.costMicroCny) : '未定价'}</td>
            <td class="num muted">${formatPercent(model.share)}</td>
          </tr>`,
        )
        .join('');
      return `<tr class="${rowClass}" data-target="${target}" data-session="${escapeHtml(session.id)}" data-created-at="${session.createdAt ?? ''}" data-running="${running}"${hiddenAttr}>
          <td class="muted nowrap">${formatTime(session.createdAt).slice(0, 10)}</td>
          <td>
            <div class="title">${escapeHtml(session.title ?? '(untitled)')}</div>
            <div class="mono subtle">${escapeHtml(session.id)}</div>
            ${flags === '' ? '' : `<div class="flags">${flags}</div>`}
          </td>
          <td>${modelChips || '<span class="muted">—</span>'}</td>
          <td class="num">${formatTokens(session.totals.totalTokens)}</td>
          <td class="cost-cell">
            <span class="strong">${session.totals.costMicroCny > 0 ? cny(session.totals.costMicroCny) : '<span class="muted">—</span>'}</span>
            ${bar(session.totals.costMicroCny, maxCost)}
          </td>
        </tr>
        <tr class="${detailClass}" id="${target}" data-session="${escapeHtml(session.id)}" data-created-at="${session.createdAt ?? ''}"${hiddenAttr}>
          <td colspan="5">
            <div class="detail-inner">
              <div class="detail-meta">
                <span>状态 ${escapeHtml(activityLabel({ running, isSubagent: subagent }))}</span>
                <span>工作区 <code>${escapeHtml(session.cwd ?? session.workspaceDir)}</code></span>
                <span>预设 ${escapeHtml(session.agentPreset ?? '—')}</span>
                <span>缓存命中 ${formatPercent(session.totals.cacheHit)}</span>
                <span>计费采样 ${session.totals.samples} 次</span>
              </div>
              <table class="mini">
                <thead><tr><th>模型</th><th>提供方</th><th class="num">输入</th><th class="num">输出</th><th class="num">缓存写</th><th class="num">缓存读</th><th class="num">费用</th><th class="num">占比</th></tr></thead>
                <tbody>${detailModels || '<tr><td colspan="8" class="muted">没有用量记录</td></tr>'}</tbody>
              </table>
            </div>
          </td>
        </tr>`;
    })
    .join('');

  const dailyRows = dailyDays
    .map((day, index) => {
      const target = `d${index}`;
      const label = day.unknown ? '未知日期' : day.day;
      const isToday = day.unknown !== true && day.day === todayKey;
      const daySessionRows = day.sessions
        .map((session) => {
          const chips = session.models
            .map(
              (model) =>
                `<span class="chip ${model.priced ? '' : 'chip-warn'}">${escapeHtml(model.model ?? 'unknown')}</span>`,
            )
            .join('');
          return `<tr>
            <td><div class="title">${escapeHtml(session.title ?? '(untitled)')}</div><div class="mono subtle">${escapeHtml(session.id)}</div></td>
            <td>${chips || '<span class="muted">—</span>'}</td>
            <td class="num">${formatTokens(session.tokens.totalTokens)}</td>
            <td class="num muted">${session.samples}</td>
            <td class="num strong">${session.costMicroCny > 0 ? cny(session.costMicroCny) : '<span class="muted">—</span>'}</td>
          </tr>`;
        })
        .join('');
      return `<tr class="day" data-target="${target}" data-day-start="${day.dayStart}" data-unknown="${day.unknown === true}">
          <td class="nowrap"><span class="strong">${escapeHtml(label)}</span>${isToday ? ' <span class="pill pill-today">今天</span>' : ''}</td>
          <td class="num">${day.sessions.length}</td>
          <td class="num">${formatTokens(day.totals.totalTokens)}</td>
          <td class="num">${formatPercent(day.totals.cacheHit)}</td>
          <td class="cost-cell">
            <span class="strong">${day.totals.costMicroCny > 0 ? cny(day.totals.costMicroCny) : '<span class="muted">—</span>'}</span>
            ${bar(day.totals.costMicroCny, maxDayCost)}
          </td>
        </tr>
        <tr class="detail" id="${target}" data-day-start="${day.dayStart}" hidden>
          <td colspan="5">
            <div class="detail-inner">
              <div class="detail-meta"><span>按采样时间切日 · 跨天会话只计入当天部分</span></div>
              <table class="mini">
                <thead><tr><th>会话</th><th>模型</th><th class="num">Token</th><th class="num">采样</th><th class="num">费用</th></tr></thead>
                <tbody>${daySessionRows || '<tr><td colspan="5" class="muted">没有用量记录</td></tr>'}</tbody>
              </table>
            </div>
          </td>
        </tr>`;
    })
    .join('');

  const runningNote = runningCount > 0 ? ` · 当前 ${runningCount} 个运行中` : '';
  const moreLabel = `显示更多（还有 ${hiddenCount} 个）`;
  const unpricedNote =
    unpriced.length > 0
      ? `<div class="note warn">未配置价格的模型：${unpriced.map(escapeHtml).join('、')}。其 token 正常统计，但费用记为 0。</div>`
      : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH 会话费用报告 · ${escapeHtml(formatTime(report.generatedAt))}</title>
<style>
  :root {
    --bg: #f4f6f9;
    --card: #ffffff;
    --text: #1c2430;
    --muted: #6b7787;
    --line: #e3e8ef;
    --accent: #0f766e;
    --accent-soft: #ccfbf1;
    --warn: #b45309;
    --warn-soft: #fef3c7;
    --shadow: 0 1px 2px rgba(16, 24, 40, .04), 0 8px 24px rgba(16, 24, 40, .05);
    --mono: ui-monospace, "Cascadia Code", "SFMono-Regular", Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 40px 24px 56px; }
  .hero { display: flex; justify-content: space-between; gap: 24px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 24px; }
  .eyebrow { font-size: 12px; letter-spacing: .14em; color: var(--accent); font-weight: 700; text-transform: uppercase; }
  h1 { font-size: 28px; line-height: 1.25; margin: 8px 0 6px; font-weight: 650; letter-spacing: -.01em; }
  .sub { color: var(--muted); font-size: 13px; }
  .sub code { font-family: var(--mono); font-size: 12px; color: var(--text); background: #eef1f5; padding: 2px 6px; border-radius: 5px; }
  .badge { background: var(--accent-soft); color: var(--accent); border-radius: 999px; padding: 5px 12px; font-size: 12px; font-weight: 600; white-space: nowrap; }
  .cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 20px 0 26px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; box-shadow: var(--shadow); }
  .card .k { color: var(--muted); font-size: 12px; }
  .card .v { font-size: 24px; font-weight: 650; margin-top: 6px; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
  .card .v small { font-size: 13px; font-weight: 500; color: var(--muted); margin-left: 4px; }
  .card .f { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .card.money .v { color: var(--accent); }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow); margin-bottom: 18px; overflow: hidden; }
  section > h2 { font-size: 13px; font-weight: 650; letter-spacing: .04em; color: var(--muted); margin: 0; padding: 16px 20px 10px; text-transform: uppercase; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 10px 14px; text-align: left; vertical-align: middle; border-top: 1px solid var(--line); }
  thead th { border-top: none; color: var(--muted); font-weight: 600; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .strong { font-weight: 650; }
  .mono { font-family: var(--mono); font-size: 12px; }
  .muted { color: var(--muted); }
  .subtle { color: #98a2b3; margin-top: 3px; font-size: 11px; }
  .nowrap { white-space: nowrap; }
  .title { font-weight: 550; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip { display: inline-block; background: #eef2f6; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; font-family: var(--mono); font-size: 11px; margin: 1px 2px; }
  .chip-warn { background: var(--warn-soft); border-color: #fcd34d; color: var(--warn); }
  .flags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
  .pill { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; padding: 0 7px; font-size: 10.5px; font-weight: 650; line-height: 17px; white-space: nowrap; }
  .pill-run { background: #dcfce7; border: 1px solid #bbf7d0; color: #15803d; }
  .pill-run i { width: 5px; height: 5px; border-radius: 50%; background: #16a34a; animation: run-pulse 1.8s ease-in-out infinite; }
  .pill-sub { background: #eef2f6; border: 1px solid var(--line); color: var(--muted); font-weight: 600; }
  .cost-cell { min-width: 132px; }
  .bar { height: 4px; background: #edf0f4; border-radius: 999px; margin-top: 6px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--accent); border-radius: 999px; opacity: .75; }
  tr.session { cursor: pointer; }
  tr.session:hover { background: #fafbfc; }
  tr.session.is-running { background: linear-gradient(90deg, rgba(15, 118, 110, .07), rgba(15, 118, 110, 0) 42%); }
  tr.session.is-running:hover { background: #f0fdfa; }
  tr.session.is-running > td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
  tr.detail { display: none; }
  tr.detail.open { display: table-row; }
  tr.detail > td { background: #fafbfc; padding: 0; border-top: none; }
  tr.session-extra[hidden] { display: none !important; }
  tr.session[hidden], tr.detail[hidden], tr.session[data-range-hidden] { display: none !important; }
  tr.day { cursor: pointer; }
  tr.day:hover { background: #fafbfc; }
  tr.day[hidden], tr.day[data-range-hidden] { display: none !important; }
  .pill-today { background: #e0f2fe; border: 1px solid #bae6fd; color: #0369a1; }
  #daily[hidden], #sessions[hidden] { display: none !important; }
  .sessions-more { display: flex; justify-content: center; padding: 12px 20px 16px; border-top: 1px solid var(--line); }
  .sessions-more[hidden] { display: none !important; }
  .empty-row td { padding: 20px; }
  /* Time-range selector: slate hairline shell, sky active pill. */
  .range-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin: 0 0 18px; }
  .time-range-selector {
    display: inline-flex; gap: 2px; padding: 3px;
    background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px;
  }
  .range-btn {
    appearance: none; border: none; background: transparent; color: #475569;
    font: inherit; font-size: 12.5px; font-weight: 550; line-height: 1.3;
    padding: 6px 13px; border-radius: 9px; cursor: pointer; white-space: nowrap;
    transition: background .15s ease, color .15s ease;
  }
  .range-btn:hover { background: #e2e8f0; color: #0f172a; }
  .range-btn.active { background: #38bdf8; color: #0f172a; box-shadow: 0 1px 2px rgba(14, 165, 233, .28); }
  .range-btn:focus-visible { outline: 2px solid #0ea5e9; outline-offset: 2px; }
  .range-flag {
    display: inline-flex; align-items: center; border-radius: 999px; padding: 1px 8px;
    background: #e0f2fe; border: 1px solid #bae6fd; color: #0369a1;
    font-size: 11px; font-weight: 650; white-space: nowrap;
  }
  .range-flag[hidden] { display: none !important; }
  .range-note { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .range-bar[data-filtered="true"] .range-note { color: #0369a1; }
  .view-selector {
    display: inline-flex; gap: 2px; padding: 3px;
    background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px;
  }
  .view-btn {
    appearance: none; border: none; background: transparent; color: #475569;
    font: inherit; font-size: 12px; font-weight: 550; line-height: 1.3;
    padding: 6px 11px; border-radius: 9px; cursor: pointer; white-space: nowrap;
    transition: background .15s ease, color .15s ease;
  }
  .view-btn:hover { background: #e2e8f0; color: #0f172a; }
  .view-btn.active { background: #e2e8f0; color: #0f172a; box-shadow: inset 0 0 0 1px #cbd5e1; }
  .view-btn:focus-visible { outline: 2px solid #0ea5e9; outline-offset: 2px; }
  .more-btn {
    appearance: none; border: 1px solid var(--line); background: #f8fafc; color: var(--accent);
    border-radius: 999px; padding: 7px 18px; font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
    transition: background .15s ease, border-color .15s ease;
  }
  .more-btn:hover { background: var(--accent-soft); border-color: #99f6e4; }
  .more-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  @keyframes run-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
  .detail-inner { padding: 14px 20px 18px 28px; }
  .detail-meta { display: flex; flex-wrap: wrap; gap: 14px; color: var(--muted); font-size: 12px; margin-bottom: 10px; }
  .detail-meta code { font-family: var(--mono); font-size: 11px; }
  table.mini { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: var(--card); }
  table.mini th, table.mini td { padding: 8px 12px; }
  .note { padding: 12px 20px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--line); }
  .note.warn { background: var(--warn-soft); color: var(--warn); border-top-color: #fcd34d; }
  footer { color: var(--muted); font-size: 12px; text-align: center; margin-top: 28px; line-height: 1.8; }
  footer code { font-family: var(--mono); font-size: 11px; }
  @media (max-width: 820px) {
    .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .title { max-width: 200px; }
    .range-btn { padding: 6px 10px; font-size: 12px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .pill-run i { animation: none; }
  }
</style>
<noscript><style>
  /* No JavaScript: show every session row instead of the five-row page and
     hide the range selector / paging controls, which cannot work without JS. */
  .range-bar { display: none !important; }
  tr.session.session-extra[hidden] { display: table-row !important; }
  .sessions-more { display: none !important; }
  #daily[hidden] { display: block !important; }
</style></noscript>
</head>
<body>
<div class="wrap">
  <div class="hero">
    <div>
      <div class="eyebrow">DeepSeek Harness · Cost Report</div>
      <h1>会话费用报告</h1>
      <div class="sub">生成于 ${escapeHtml(formatTime(report.generatedAt))} · 数据目录 <code>${escapeHtml(report.home)}</code></div>
    </div>
    <div class="badge">${escapeHtml(report.currency)} · ${formatTokens(report.unitTokens)} tokens 计价</div>
  </div>

  <div class="range-bar" id="dsh-cost-range" data-filtered="false">
    <div class="time-range-selector" role="group" aria-label="时间范围">
      <button type="button" class="range-btn active" data-range="all" aria-pressed="true">All time</button>
      <button type="button" class="range-btn" data-range="30d" aria-pressed="false">Last 30 days</button>
      <button type="button" class="range-btn" data-range="7d" aria-pressed="false">Last 7 days</button>
      <button type="button" class="range-btn" data-range="today" aria-pressed="false">Today</button>
    </div>
    <div class="view-selector" role="group" aria-label="统计视图">
      <button type="button" class="view-btn active" data-view="session" aria-pressed="true">按会话</button>
      <button type="button" class="view-btn" data-view="daily" aria-pressed="false">按天</button>
    </div>
    <span class="range-flag" data-range-flag hidden>已筛选</span>
    <span class="range-note" data-range-note aria-live="polite">${escapeHtml(rangeNote)}</span>
  </div>

  <div class="cards">
    <div class="card money">
      <div class="k">总费用</div>
      <div class="v" id="stat-cost">${formatCny(summary.costCny)}</div>
      <div class="f" id="stat-cost-note">${pricedCount} / ${summary.sessions} 个会话产生费用</div>
    </div>
    <div class="card">
      <div class="k">总 Token</div>
      <div class="v" id="stat-tokens">${formatTokens(summary.totalTokens)}</div>
      <div class="f" id="stat-tokens-note">in ${formatTokens(summary.inputTokens)} · out ${formatTokens(summary.outputTokens)}</div>
    </div>
    <div class="card">
      <div class="k">缓存读取</div>
      <div class="v" id="stat-cache-read">${formatTokens(summary.cacheReadTokens)}</div>
      <div class="f" id="stat-cache-read-note">占计费输入 ${formatPercent(summary.cacheHit)}</div>
    </div>
    <div class="card">
      <div class="k">缓存节省</div>
      <div class="v" id="stat-cache-saving">${cny(cacheSavingMicro)}</div>
      <div class="f">相对未缓存输入价估算</div>
    </div>
  </div>

  ${unpricedNote}

  <section>
    <h2>按模型汇总</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>模型</th><th>提供方</th><th class="num">输入</th><th class="num">输出</th><th class="num">缓存写</th><th class="num">缓存读</th><th class="num">费用</th><th class="num">会话</th></tr>
        </thead>
        <tbody id="model-summary-body">${modelRows || '<tr><td colspan="8" class="muted" style="padding:20px">没有用量记录</td></tr>'}</tbody>
      </table>
    </div>
  </section>

  <section id="sessions">
    <h2>会话明细（按创建时间 · 运行中优先${runningNote} · 点击行展开模型明细）</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>日期</th><th>会话</th><th>模型</th><th class="num">Token</th><th class="cost-cell">费用</th></tr>
        </thead>
        <tbody>${sessionRows}<tr id="sessions-empty" class="empty-row"${sessions.length === 0 ? '' : ' hidden'}><td colspan="5" class="muted">无符合条件的会话</td></tr></tbody>
      </table>
    </div>
    ${
      hiddenCount > 0
        ? `<div class="sessions-more" data-sessions-more><button type="button" class="more-btn" data-sessions-toggle data-more-label="${escapeHtml(moreLabel)}" aria-expanded="false">${escapeHtml(moreLabel)}</button></div>`
        : ''
    }
  </section>

  <section id="daily" hidden>
    <h2>按天费用（按采样时间切日 · 跨天会话会拆分 · 点击行展开当天会话）</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>日期</th><th class="num">会话</th><th class="num">Token</th><th class="num">缓存命中</th><th class="cost-cell">费用</th></tr>
        </thead>
        <tbody>${dailyRows}<tr id="daily-empty" class="empty-row"${dailyDays.length === 0 ? '' : ' hidden'}><td colspan="5" class="muted">无符合条件的花费</td></tr></tbody>
      </table>
    </div>
    <div class="note">按采样时间切日，同一会话跨天会拆分到两天；按天视图下 Today / 7 天 / 30 天按自然日计算（含今天），边界使用本机时区。</div>
  </section>

  <section>
    <h2>价格表（${escapeHtml(report.currency)} / ${formatTokens(report.unitTokens)} tokens）</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>模型</th><th class="num">输入</th><th class="num">输出</th><th class="num">缓存创建</th><th class="num">缓存读取</th></tr></thead>
        <tbody>${priceRows}</tbody>
      </table>
    </div>
    ${tariffNotes}
    <div class="note">未定价模型仍统计 token，但费用记为 0。模型 id 匹配忽略 provider 前缀与日期后缀，并支持 <code>*</code> 前缀通配。</div>
  </section>

  <footer>
    由 <code>dsh-cost</code> 生成 · 计费口径与 DSH <code>tokenUsage</code> 投影一致（同一步骤的最终样本替换流式样本，重试计为独立样本）<br>
    费用为按公开价格估算，非账单凭证。
  </footer>
  <script type="application/json" id="dsh-cost-data">${datasetJson}</script>
</div>
<script>
${timeRangeRuntimeSource()}
  (function () {
    var runtime = window.DSH_TIME_RANGE;
    if (!runtime) return;
    var storage = null;
    try {
      storage = window.localStorage;
    } catch (error) {
      storage = null;
    }
    var range = runtime.normalizeTimeRange(urlParam('range') || runtime.readSavedRange(storage));
    var view = runtime.normalizeView(urlParam('view') || runtime.readSavedView(storage));
    var expanded = false;
    function urlParam(name) {
      try {
        return new URLSearchParams(window.location.search).get(name);
      } catch (error) {
        return null;
      }
    }
    function syncUrl() {
      try {
        var next = new URL(window.location.href);
        next.searchParams.set('range', range);
        next.searchParams.set('view', view);
        window.history.replaceState(null, '', next.toString());
      } catch (error) {
        /* file:// or restricted history: URL state is optional */
      }
    }
    function applyView() {
      runtime.applyTimeRange(document, { range: range, showAll: expanded, view: view });
    }
    runtime.bindRangeSelector(document, function (next) {
      range = next;
      runtime.saveRange(storage, next);
      applyView();
      syncUrl();
    });
    runtime.bindViewSelector(document, function (next) {
      view = next;
      runtime.saveView(storage, next);
      applyView();
      syncUrl();
    });
    document.querySelectorAll('tr.session, tr.day').forEach(function (row) {
      row.addEventListener('click', function () {
        var detail = document.getElementById(row.dataset.target);
        if (!detail) return;
        detail.classList.toggle('open');
      });
    });
    var section = document.getElementById('sessions');
    if (section) {
      var button = section.querySelector('[data-sessions-toggle]');
      if (button) {
        button.addEventListener('click', function () {
          expanded = !expanded;
          applyView();
          section.classList.toggle('sessions-expanded', expanded);
        });
      }
    }
    applyView();
  })();
</script>
</body>
</html>`;
}
