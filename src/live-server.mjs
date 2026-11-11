/**
 * A tiny local HTTP server for the live dashboard.
 *
 * Routes (GET/HEAD unless noted, no directory serving):
 *   /                 the live page (server-rendered snapshot + polling client)
 *   /api/fragment     fresh report body + metadata, consumed every 20 s
 *   /api/report       the same JSON document as `dsh-cost report --format json`
 *   /api/health       liveness/scan diagnostics
 *   /api/billing      local settings (PUT is loopback-only, same-origin JSON)
 *   /api/report.csv   current server report in CSV format
 *
 * The server binds to loopback by default and refreshes on demand: each poll
 * re-reads the DSH session logs. A 1-second cache coalesces simultaneous
 * requests without making the page feel stale.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { formatMoney } from './money.mjs';
import { formatCny, formatTokens } from './pricing.mjs';
import {
  DEFAULT_INTERVAL_MS,
  DEFAULT_PORT,
  LIVE_VERSION,
  collectLiveReport,
  renderLiveDocument,
  renderLiveFragment,
  summarizeReport,
} from './live.mjs';
import { localeFromAcceptLanguage, normalizeLocale } from './i18n.mjs';
import { loadBilling, saveBilling } from './billing-config.mjs';
import { toCsv } from './report-data.mjs';
import { normalizeBilling } from './billing.mjs';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/** `HH:mm:ss` in local time, for console lines. */
export function clockLabel(ms = Date.now()) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Open a URL in the platform browser without blocking (or throwing). */
export function openBrowser(url) {
  const options = { stdio: 'ignore', detached: true, windowsHide: true };
  try {
    let child;
    if (process.platform === 'win32') child = spawn('cmd', ['/c', 'start', '', url], options);
    else if (process.platform === 'darwin') child = spawn('open', [url], options);
    else child = spawn('xdg-open', [url], options);
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Write a JSON response. */
function sendJson(response, status, value, headOnly = false) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  response.writeHead(status, { ...JSON_HEADERS, 'Content-Length': body.length });
  response.end(headOnly ? undefined : body);
}

/** Write an HTML response. */
function sendHtml(response, status, html, headOnly = false) {
  const body = Buffer.from(html, 'utf8');
  response.writeHead(status, { ...HTML_HEADERS, 'Content-Length': body.length });
  response.end(headOnly ? undefined : body);
}

/** Write a plain-text response. */
function sendText(response, status, text) {
  const body = Buffer.from(`${text}\n`, 'utf8');
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
  });
  response.end(body);
}

/** Wait for `server.listen`, resolving to the bound port. */
function listenOnce(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Start the live server.
 *
 * @param {object} [options]
 * @param {string} [options.host='127.0.0.1']
 * @param {number} [options.port=4173] - 0 picks a free port.
 * @param {number} [options.intervalMs=20000] - sent to the browser.
 * @param {object} [options.reportOptions] - home/pricing/model/... filters.
 * @param {boolean} [options.open=false] - open the page after listening.
 * @param {boolean} [options.portFallback=true] - try port+1..+20 when busy.
 * @param {string} [options.title]
 * @param {Console} [options.logger]
 * @returns {Promise<{server: import('node:http').Server, host: string, port: number, url: string, close: () => Promise<void>, refresh: () => object, current: () => object|null}>}
 */
export async function startLiveServer(options = {}) {
  const {
    host = '127.0.0.1',
    port = DEFAULT_PORT,
    intervalMs = DEFAULT_INTERVAL_MS,
    reportOptions = {},
    open = false,
    portFallback = true,
    title = null,
    logger = console,
    locale: rawLocale = null,
  } = options;
  // Server default locale: --lang / DSH_COST_LANG, else zh; a request can still
  // override it with ?lang= or Accept-Language.
  const defaultLocale = normalizeLocale(rawLocale ?? 'zh');
  // With no explicit title, each render falls back to app.title in its own
  // locale (see renderLiveDocument), so an English page gets an English title.
  const pageTitle = typeof title === 'string' && title !== '' ? title : null;

  const startedAt = Date.now();
  const warned = new Set();
  const collectOptions = {
    ...reportOptions,
    onWarning(message) {
      if (warned.has(message)) return;
      warned.add(message);
      logger.warn?.(`[${clockLabel()}] 警告: ${message}`);
    },
  };

  let cache = null;
  let lastError = null;
  let scans = 0;
  let lastScanMs = 0;
  let lastSignature = '';

  function signatureOf(report) {
    return `${report.summary.sessions}|${report.summary.costMicroCny}|${report.summary.costMicroUsd}|${report.summary.totalTokens}`;
  }

  function logChange(previous, report, scanMs) {
    const signature = signatureOf(report);
    if (signature === lastSignature) return;
    lastSignature = signature;
    const parts = [
      `${report.summary.sessions} 会话`,
      formatMoney(report.summary.costMicroCny, report.summary.costMicroUsd),
      `${formatTokens(report.summary.totalTokens)} tokens`,
    ];
    if (previous !== null) {
      const deltaCny = report.summary.costMicroCny - previous.summary.costMicroCny;
      const deltaUsd = (report.summary.costMicroUsd ?? 0) - (previous.summary.costMicroUsd ?? 0);
      const deltaTokens = report.summary.totalTokens - previous.summary.totalTokens;
      if (deltaCny > 0 || deltaUsd > 0 || deltaTokens > 0) {
        parts.push(`(+${formatMoney(Math.max(0, deltaCny), Math.max(0, deltaUsd))} · +${formatTokens(deltaTokens)} tokens)`);
      }
    }
    parts.push(`${scanMs}ms`);
    logger.log?.(`[${clockLabel()}] ${parts.join(' · ')}`);
  }

  /**
   * Recompute the report. With `force=false`, a sub-second-old snapshot is
   * reused so one page load plus its first poll does not scan twice.
   * On failure the last good snapshot is served with `error` attached.
   */
  function refresh(force = true) {
    const now = Date.now();
    if (!force && cache !== null && now - cache.at < 1000) return cache;
    const started = Date.now();
    try {
      const report = collectLiveReport(collectOptions);
      const scanMs = Math.max(1, Date.now() - started);
      scans += 1;
      lastScanMs = scanMs;
      lastError = null;
      const fragment = renderLiveFragment(report, { locale: defaultLocale });
      const page = renderLiveDocument({ report, mode: 'http', intervalMs, title: pageTitle, serverUrl: null, locale: defaultLocale });
      const previous = cache?.report ?? null;
      cache = { at: Date.now(), report, fragment, page, error: null };
      logChange(previous, report, scanMs);
      return cache;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (cache !== null) {
        cache = { ...cache, error: lastError };
        return cache;
      }
      throw error;
    }
  }

  // Fail fast on a bad home / pricing table, exactly like the CLI.
  refresh(true);

  const server = createServer(async (request, response) => {
    const method = request.method ?? 'GET';
    if (method === 'PUT' && request.url === '/api/billing') {
      // Custom JSON header + exact Origin stops CSRF and cross-origin writes.
      // Host checking also stops DNS rebinding against this local/trusted-LAN service.
      const peer = request.socket.remoteAddress;
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) { sendJson(response, 403, { error: 'Settings writes require a loopback connection; use an SSH tunnel for remote administration' }); request.resume(); return; }
      const authority = request.headers.host ?? '';
      const hostname = authority.startsWith('[') ? authority.slice(1, authority.indexOf(']')) : authority.split(':')[0];
      const address = server.address();
      const allowedHosts = ['localhost', '127.0.0.1', '::1', host, address?.address];
      const { networkInterfaces } = await import('node:os');
      for (const entries of Object.values(networkInterfaces())) for (const entry of entries ?? []) allowedHosts.push(entry.address);
      const origin = request.headers.origin;
      if (!allowedHosts.includes(hostname) || !origin || origin !== 'http://' + authority || request.headers['x-costlive-settings'] !== '1' || request.headers['content-type'] !== 'application/json' || (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) {
        sendJson(response, 403, { error: 'Only same-origin settings requests are allowed' }); return;
      }
      try {
        if (Number(request.headers['content-length'] ?? 0) > 65536) { sendJson(response, 413, {error:'Settings body too large'}); request.resume(); return; }
        let text = ''; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 65536) { sendJson(response, 413, {error:'Settings body too large'}); request.destroy(); return; } text += chunk.toString('utf8'); }
        const config = normalizeBilling(JSON.parse(text));
        if (reportOptions.billingDocument || reportOptions.billingMode || reportOptions.model || reportOptions.workspace || reportOptions.top || reportOptions.pricedOnly) throw new Error('Settings are read-only when report overrides or scope filters are active');
        saveBilling(reportOptions.billingPath, config);
        cache = null;
        refresh(true);
        sendJson(response, 200, { ok: true, config });
      } catch (error) { sendJson(response, 400, { error: error.message }); }
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      sendText(response, 405, 'Method Not Allowed');
      return;
    }
    const headOnly = method === 'HEAD';
    let pathname = '/';
    let query = new URLSearchParams();
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      pathname = url.pathname;
      query = url.searchParams;
    } catch {
      sendText(response, 400, 'Bad Request');
      return;
    }
    // `?lang=en` wins, then Accept-Language, then the default (zh).
    const requested = query.get('lang');
    const locale =
      requested !== null && requested !== ''
        ? normalizeLocale(requested)
        : localeFromAcceptLanguage(request.headers['accept-language'] ?? '');

    try {
      if (pathname === '/' || pathname === '/index.html') {
        const current = refresh(false);
        const page = locale === defaultLocale ? current.page : renderLiveDocument({ report: current.report, mode: 'http', intervalMs, title: pageTitle, serverUrl: null, locale });
        sendHtml(response, 200, page, headOnly);
        return;
      }
      if (pathname === '/api/fragment') {
        const current = refresh(false);
        if (locale !== defaultLocale) {
          sendJson(
            response,
            200,
            {
              ...renderLiveFragment(current.report, { locale }),
              intervalMs,
              stale: Boolean(current.error),
              error: current.error ?? null,
              scans,
            },
            headOnly,
          );
          return;
        }
        sendJson(
          response,
          200,
          {
            ...current.fragment,
            intervalMs,
            stale: Boolean(current.error),
            error: current.error ?? null,
            scans,
          },
          headOnly,
        );
        return;
      }
      if (pathname === '/api/billing') { sendJson(response, 200, loadBilling(reportOptions.billingPath), headOnly); return; }
      if (pathname === '/api/report.csv') {
        const current = refresh(true);
        const text = toCsv(current.report);
        response.writeHead(200, { ...JSON_HEADERS, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="costlive.csv"' });
        response.end(headOnly ? undefined : text); return;
      }
      if (pathname === '/api/report') {
        const current = refresh(true);
        sendJson(
          response,
          200,
          {
            ...current.report,
            live: { stale: Boolean(current.error), error: current.error ?? null, scans, lastScanMs },
          },
          headOnly,
        );
        return;
      }
      if (pathname === '/api/health') {
        const current = cache;
        sendJson(
          response,
          200,
          {
            ok: lastError === null,
            tool: 'dsh-cost-live',
            version: LIVE_VERSION,
            uptimeMs: Date.now() - startedAt,
            scans,
            lastScanMs,
            lastError,
            intervalMs,
            home: current?.report.home ?? null,
            generatedAt: current?.report.generatedAt ?? null,
            stale: Boolean(current?.error),
            ...(current ? summarizeReport(current.report) : {}),
          },
          headOnly,
        );
        return;
      }
      if (pathname === '/favicon.ico') {
        response.writeHead(204, { 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      sendText(response, 404, 'Not Found');
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { ok: false, error: lastError });
    }
  });

  const attempts = portFallback && port !== 0 ? 20 : 1;
  let boundPort = null;
  let lastListenError = null;
  for (let offset = 0; offset < attempts; offset += 1) {
    const candidate = port + offset;
    if (candidate > 65535) break;
    try {
      boundPort = await listenOnce(server, host, candidate);
      break;
    } catch (error) {
      lastListenError = error;
      if (error.code !== 'EADDRINUSE' || offset === attempts - 1) throw error;
    }
  }
  if (boundPort === null) {
    throw lastListenError ?? new Error('无法绑定本地端口');
  }

  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${displayHost.includes(':') ? `[${displayHost}]` : displayHost}:${boundPort}/`;
  const current = cache;

  logger.log?.('dsh-cost live · 实时费用面板');
  logger.log?.(`  地址   ${url}`);
  logger.log?.(
    current.report.sources?.length > 0
      ? `  数据   ${current.report.sources.map((source) => `${source.label}=${source.sessions}${source.error ? '(offline)' : ''}`).join(' · ')}`
      : `  数据   ${current.report.home}`,
  );
  logger.log?.(`  刷新   每 ${Math.round(intervalMs / 1000)} 秒（浏览器拉取 /api/fragment）`);
  logger.log?.(`  会话   ${current.report.summary.sessions} 个 · ${formatMoney(current.report.summary.costMicroCny, current.report.summary.costMicroUsd)} · ${formatTokens(current.report.summary.totalTokens)} tokens`);
  logger.log?.('  停止   Ctrl+C');
  if (open) openBrowser(url);

  async function close() {
    try {
      server.closeAllConnections?.();
    } catch {
      /* Node < 18.2 */
    }
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  return {
    server,
    host,
    port: boundPort,
    url,
    close,
    refresh: () => refresh(true),
    current: () => cache,
  };
}
