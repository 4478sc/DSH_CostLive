/**
 * Live dashboard support.
 *
 * `collectLiveReport` reuses the same discovery/fold/report pipeline as the CLI.
 * `renderLiveDocument` reuses the standalone report renderer and only splits its
 * CSS / `.wrap` markup, so the live page keeps the exact report styling and
 * layout. The browser swaps that `.wrap` on every refresh.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sortSessionResults } from './activity.mjs';
import { analyzeEvents } from './engine.mjs';
import { loadPricing } from './pricing.mjs';
import { buildReport } from './report-data.mjs';
import { escapeHtml, renderHtml } from './report-html.mjs';
import { discoverSessions, readSession, resolveHome } from './sessions.mjs';
import { timeRangeRuntimeSource } from './time-range.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Browser refresh cadence used by every live mode. */
export const DEFAULT_INTERVAL_MS = 20_000;
/** Guard-rail so a mistyped `--interval 0` cannot hammer the disk. */
export const MIN_INTERVAL_MS = 5_000;
export const DEFAULT_PORT = 4173;
export const DEFAULT_OUTPUT = resolve(HERE, '..', 'out', 'dsh-cost-live.html');
export const LIVE_ENDPOINT = '/api/fragment';
export const LIVE_VERSION = 1;

const CLIENT_SOURCE = readFileSync(new URL('./live-client.js', import.meta.url), 'utf8');

/**
 * Live-dock CSS. Appended after the report CSS, so the report itself is
 * untouched; every selector is namespaced with `ld-` / `.live-dock`.
 */
const LIVE_CSS = `
  body.live-body { padding-bottom: 152px; }
  .live-dock {
    position: fixed; right: 20px; bottom: 20px; z-index: 1000; width: 272px;
    padding: 12px 14px 11px; background: rgba(255, 255, 255, .96);
    border: 1px solid var(--line); border-radius: 14px;
    box-shadow: 0 2px 6px rgba(16, 24, 40, .06), 0 16px 40px rgba(16, 24, 40, .14);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    color: var(--text);
    font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
  }
  .live-dock * { box-sizing: border-box; }
  .ld-head { display: flex; align-items: center; gap: 7px; }
  .ld-dot {
    flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--accent);
    box-shadow: 0 0 0 3px rgba(15, 118, 110, .14); animation: ld-breathe 2.4s ease-in-out infinite;
  }
  .ld-label { font-weight: 650; letter-spacing: .01em; }
  .ld-time { margin-left: auto; color: var(--muted); font: 11px/1.45 var(--mono); font-variant-numeric: tabular-nums; }
  .ld-progress { height: 3px; margin: 9px 0 8px; border-radius: 999px; background: #edf0f4; overflow: hidden; }
  .ld-progress i {
    display: block; width: 0; height: 100%; border-radius: 999px;
    background: var(--accent); transition: width .24s linear;
  }
  .ld-sub { color: var(--muted); font-size: 11px; }
  .ld-metrics { margin-top: 7px; font-size: 12.5px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -.01em; white-space: pre-line; line-height: 1.5; }
  .ld-actions { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
  .ld-btn {
    appearance: none; border: 1px solid var(--line); background: #f8fafc; color: var(--text);
    border-radius: 8px; padding: 4px 10px; font: inherit; font-size: 11.5px; cursor: pointer;
    transition: background .15s ease, border-color .15s ease;
  }
  .ld-btn:hover { background: #eef2f6; border-color: #d5dbe4; }
  .ld-btn:disabled { opacity: .55; cursor: default; }
  .ld-link { margin-left: auto; color: var(--accent); font-size: 11.5px; font-weight: 550; text-decoration: none; }
  .ld-link:hover { text-decoration: underline; }
  .ld-link[hidden] { display: none; }
  .ld-note { margin-top: 9px; padding: 7px 9px; border-radius: 8px; background: var(--warn-soft); color: var(--warn); font-size: 11px; line-height: 1.5; }
  .ld-note[hidden] { display: none !important; }
  .ld-note.error { background: #fee4e2; color: #b42318; }
  .live-dock[data-state="error"] .ld-dot { background: #d92d20; box-shadow: 0 0 0 3px rgba(217, 45, 32, .14); animation: none; }
  .live-dock[data-state="error"] .ld-progress i { background: #d92d20; }
  .live-dock[data-state="paused"] .ld-dot,
  .live-dock[data-state="static"] .ld-dot { background: #98a2b3; box-shadow: none; animation: none; }
  .live-dock[data-state="paused"] .ld-progress i,
  .live-dock[data-state="static"] .ld-progress i { background: #98a2b3; }
  .live-dock[data-state="stale"] .ld-dot { background: #d97706; box-shadow: 0 0 0 3px rgba(217, 119, 6, .14); animation: none; }
  .live-dock[data-state="stale"] .ld-progress i { background: #d97706; }
  .live-dock[data-state="loading"] .ld-dot { animation-duration: .8s; }
  .live-dock.ld-pulse { animation: ld-dock-pulse .9s ease-out; }
  .card.money.ld-flash { animation: ld-card-flash 1.6s ease-out; }
  @keyframes ld-breathe {
    0%, 100% { box-shadow: 0 0 0 3px rgba(15, 118, 110, .14); }
    50% { box-shadow: 0 0 0 5px rgba(15, 118, 110, .07); }
  }
  @keyframes ld-dock-pulse { from { border-color: var(--accent); } to { border-color: var(--line); } }
  @keyframes ld-card-flash { from { background: #ecfdf5; } to { background: var(--card); } }
  @media (max-width: 640px) {
    body.live-body { padding-bottom: 196px; }
    .live-dock { left: 12px; right: 12px; bottom: 12px; width: auto; }
  }
  @media (prefers-reduced-motion: reduce) {
    .ld-dot, .live-dock.ld-pulse, .card.money.ld-flash { animation: none !important; }
  }
`;

/** Parse a date bound exactly like the CLI (`date-only` means local day boundary). */
export function parseDateBound(value, endOfDay) {
  if (value === undefined) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(value);
  const ms = Date.parse(dateOnly ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}` : value);
  if (!Number.isFinite(ms)) throw new Error(`invalid date: ${value}`);
  return ms;
}

/** Filter and sort analyzed sessions with the same semantics as `dsh-cost list`. */
function filterResults(results, options) {
  let filtered = results;
  if (typeof options.model === 'string' && options.model !== '') {
    const needle = options.model.toLowerCase();
    filtered = filtered.filter((result) =>
      result.analysis.byModel.some((entry) => String(entry.model ?? '').toLowerCase().includes(needle)),
    );
  }
  if (options.pricedOnly === true) filtered = filtered.filter((result) => result.analysis.totals.costMicroCny > 0);
  if (options.includeEmpty !== true) filtered = filtered.filter((result) => result.analysis.totals.samples > 0);
  // Match the CLI: cost decides --top selection, then running sessions float up.
  filtered.sort(
    (a, b) =>
      b.analysis.totals.costMicroCny - a.analysis.totals.costMicroCny ||
      (b.meta.createdAt ?? 0) - (a.meta.createdAt ?? 0),
  );
  if (options.top !== undefined) filtered = filtered.slice(0, options.top);
  return sortSessionResults(filtered);
}

/**
 * Collect one fresh report. Synchronous by design: one scan takes ~0.2 s on a
 * normal DSH home, and the server serializes refresh requests.
 *
 * @param {object} options - home/pricing/model/workspace/since/until/top filters.
 * @returns {object} the same document emitted by `dsh-cost report --format json`.
 */
export function collectLiveReport(options = {}) {
  const home = resolveHome(options.home);
  if (!existsSync(home)) throw new Error(`DSH 数据目录不存在: ${home}`);
  const pricing =
    options.pricingDocument ??
    loadPricing(options.pricingPath === undefined ? undefined : resolve(options.pricingPath));
  const since = parseDateBound(options.since, false);
  const until = parseDateBound(options.until, true);
  const descriptors = discoverSessions({ home, workspace: options.workspace, since, until });
  const results = [];
  for (const descriptor of descriptors) {
    try {
      const { meta, events, projection } = readSession(descriptor);
      results.push({ meta, analysis: analyzeEvents(events, pricing), projection });
    } catch (error) {
      if (typeof options.onWarning === 'function') {
        options.onWarning(`无法读取 ${descriptor.logPath}: ${error.message}`);
      }
    }
  }
  return buildReport({
    home,
    pricing,
    results: filterResults(results, options),
    generatedAt: Date.now(),
  });
}

/**
 * Split the standalone report into its CSS and its `.wrap` markup.
 * @param {string} html - output of `renderHtml(report)`.
 * @returns {{styles: string, body: string}}
 */
export function splitReportHtml(html) {
  const style = /<style>([\s\S]*?)<\/style>/u.exec(html);
  const openTag = '<div class="wrap">';
  const start = html.indexOf(openTag);
  const script = html.indexOf('<script>', start + openTag.length);
  const end = html.lastIndexOf('</div>', script === -1 ? html.length : script);
  if (style === null || start === -1 || end <= start) {
    throw new Error('无法解析 dsh-cost 报告 HTML（模板结构已变化？）');
  }
  return { styles: style[1], body: html.slice(start, end + '</div>'.length) };
}

/** Public API answer for `/api/fragment` and `GET /api/report`. */
export function summarizeReport(report) {
  return {
    generatedAt: report.generatedAt,
    generatedAtISO: report.generatedAtISO,
    home: report.home,
    currency: report.currency,
    unitTokens: report.unitTokens,
    sessions: report.summary.sessions,
    pricedSessions: report.summary.pricedSessions,
    costCny: report.summary.costCny,
    totalTokens: report.summary.totalTokens,
    inputTokens: report.summary.inputTokens,
    outputTokens: report.summary.outputTokens,
    cacheReadTokens: report.summary.cacheReadTokens,
    cacheWriteTokens: report.summary.cacheWriteTokens,
    cacheHit: report.summary.cacheHit,
    unpricedModels: report.summary.unpricedModels,
  };
}

/** HTML body fragment swapped into the open page on every refresh. */
export function renderLiveFragment(report) {
  const { body } = splitReportHtml(renderHtml(report));
  return {
    generatedAt: report.generatedAt,
    generatedAtISO: report.generatedAtISO,
    summary: summarizeReport(report),
    html: body,
  };
}

/** Escape a JSON value so it is safe inside an inline `<script>`. */
function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003c')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');
}

/**
 * Build the complete live page.
 *
 * @param {object} options
 * @param {object} options.report - report object from `collectLiveReport`.
 * @param {'http'|'file'} [options.mode] - polling source.
 * @param {number} [options.intervalMs] - refresh cadence.
 * @param {boolean} [options.autoReload] - file mode only: reload after `intervalMs`.
 * @param {string|null} [options.serverUrl] - "open the live version" link in file mode.
 * @param {string} [options.title]
 * @returns {string} standalone HTML document.
 */
export function renderLiveDocument(options) {
  const {
    report,
    mode = 'http',
    intervalMs = DEFAULT_INTERVAL_MS,
    autoReload = false,
    serverUrl = null,
    title = 'DSH 会话费用 · 实时',
  } = options;
  const { styles, body } = splitReportHtml(renderHtml(report));
  const bodyWithId = body.replace('<div class="wrap">', '<div class="wrap" id="live-wrap">');
  const config = {
    version: LIVE_VERSION,
    mode: mode === 'file' ? 'file' : 'http',
    intervalMs,
    autoReload: mode === 'file' && autoReload === true,
    generatedAt: report.generatedAt,
    endpoint: LIVE_ENDPOINT,
    serverUrl,
  };

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<meta name="color-scheme" content="light">
<meta name="generator" content="dsh-cost live ${LIVE_VERSION}">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%230f766e'/%3E%3Ctext x='16' y='22' font-family='sans-serif' font-size='16' font-weight='700' text-anchor='middle' fill='white'%3E%C2%A5%3C/text%3E%3C/svg%3E">
<style>
${styles}${LIVE_CSS}</style>
</head>
<body class="live-body">
${bodyWithId}
<noscript><div class="note warn">实时刷新需要启用 JavaScript；当前显示的是服务端生成的快照。</div></noscript>
<script>window.__DSH_LIVE__ = ${scriptJson(config)};</script>
<script>
${timeRangeRuntimeSource()}
</script>
<script>
${CLIENT_SOURCE}
</script>
</body>
</html>`;
}

/**
 * Atomically write a standalone live HTML file.
 * @returns {string} absolute path written.
 */
export function writeLiveSnapshot(options) {
  const target = resolve(options.outPath);
  mkdirSync(dirname(target), { recursive: true });
  const html = renderLiveDocument(options);
  const temporary = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(temporary, html, 'utf8');
  try {
    renameSync(temporary, target);
  } catch {
    // Some Windows setups refuse to replace a file another process holds open;
    // fall back to a direct write rather than leaving the dashboard unbuilt.
    writeFileSync(target, html, 'utf8');
    try {
      unlinkSync(temporary);
    } catch {
      /* best effort */
    }
  }
  return target;
}
