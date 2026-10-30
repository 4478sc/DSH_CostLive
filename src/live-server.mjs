/**
 * A tiny local HTTP server for the live dashboard.
 *
 * Routes (all GET/HEAD, no directory serving):
 *   /                 the live page (server-rendered snapshot + polling client)
 *   /api/fragment     fresh report body + metadata, consumed every 20 s
 *   /api/report       the same JSON document as `dsh-cost report --format json`
 *   /api/health       liveness/scan diagnostics
 *
 * The server binds to loopback by default and refreshes on demand: each poll
 * re-reads the DSH session logs. A 1-second cache coalesces simultaneous
 * requests without making the page feel stale.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
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
    title = 'DSH 会话费用 · 实时',
    logger = console,
  } = options;

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
    return `${report.summary.sessions}|${report.summary.costMicroCny}|${report.summary.totalTokens}`;
  }

  function logChange(previous, report, scanMs) {
    const signature = signatureOf(report);
    if (signature === lastSignature) return;
    lastSignature = signature;
    const parts = [
      `${report.summary.sessions} 会话`,
      formatCny(report.summary.costCny),
      `${formatTokens(report.summary.totalTokens)} tokens`,
    ];
    if (previous !== null) {
      const deltaCost = report.summary.costMicroCny - previous.summary.costMicroCny;
      const deltaTokens = report.summary.totalTokens - previous.summary.totalTokens;
      if (deltaCost > 0 || deltaTokens > 0) {
        parts.push(`(+${formatCny(deltaCost / 1e6)} · +${formatTokens(deltaTokens)} tokens)`);
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
      const fragment = renderLiveFragment(report);
      const page = renderLiveDocument({ report, mode: 'http', intervalMs, title, serverUrl: null });
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

  const server = createServer((request, response) => {
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      sendText(response, 405, 'Method Not Allowed');
      return;
    }
    const headOnly = method === 'HEAD';
    let pathname = '/';
    try {
      pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      sendText(response, 400, 'Bad Request');
      return;
    }

    try {
      if (pathname === '/' || pathname === '/index.html') {
        const current = refresh(false);
        sendHtml(response, 200, current.page, headOnly);
        return;
      }
      if (pathname === '/api/fragment') {
        const current = refresh(false);
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
  logger.log?.(`  会话   ${current.report.summary.sessions} 个 · ${formatCny(current.report.summary.costCny)} · ${formatTokens(current.report.summary.totalTokens)} tokens`);
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
