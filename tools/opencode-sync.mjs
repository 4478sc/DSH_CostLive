#!/usr/bin/env node
/**
 * Mirror OpenCode's inference logs into a local append-only archive.
 *
 * The console only keeps 30 days (`retentionDays`), so this job is what makes
 * long-lived dashboards possible: run it every minute and the store keeps every
 * request it has ever seen.
 *
 *   node tools/opencode-sync.mjs [--config config/official.json] [--loop]
 *                                [--interval 60] [--full] [--stats] [--dry-run]
 *                                [--check-auth]
 *
 * Auth: `OPENCODE_GO_API_KEY` from the environment or from the DSH credential
 * store (`~/.dsh/.credentials.yaml`, `refs:` section).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  expandPath,
  loadOfficialConfig,
  loadOfficialStore,
  mergeOfficialRecords,
  describeSyncFailure,
  normalizeLogItem,
  readApiKey,
  summarizeStore,
} from '../src/opencode-usage.mjs';

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'));
const DEFAULT_CONFIG = resolve(HERE, '..', 'config', 'official.json');
const PAGE_LIMIT = 100;
const MAX_PAGES = 2000;

/** How long the loop waits before the next attempt (see nextSyncDelay). */
const AUTH_RETRY_MS = 5 * 60 * 1000;

/** 401/403 from the console: terminal, so the loop must not hammer it. */
export class SyncAuthError extends Error {
  constructor(failure) {
    super(`HTTP ${failure.status}${failure.tag ? ` ${failure.tag}` : ''}: ${failure.hint}`);
    this.name = 'SyncAuthError';
    this.failure = failure;
  }
}

/**
 * One writer per store: a second loop (or a manual run next to the dashboard's
 * loop) would append the same rows twice until the next dedupe.
 */
/**
 * A pid in the lock file is only "another sync" when that pid still exists AND
 * really is an opencode-sync process. Pids get recycled across reboots, and a
 * bare `process.kill(pid, 0)` would then block the loop forever (seen 2026-11-02).
 */
function isSyncProcess(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('opencode-sync');
  } catch {
    /* no /proc (Windows/macOS) or the pid is gone */
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireStoreLock(store) {
  const file = `${store}/.sync.pid`;
  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf8').trim();
    if (/^\d+$/u.test(raw)) {
      const pid = Number(raw);
      if (isSyncProcess(pid)) return { ok: false, pid, file };
      /* stale pid (crashed run or a recycled pid): take the lock over */
    }
  }
  writeFileSync(file, String(process.pid), 'utf8');
  const release = () => {
    try {
      if (readFileSync(file, 'utf8').trim() === String(process.pid)) rmSync(file, { force: true });
    } catch {
      /* already gone */
    }
  };
  process.once('exit', release);
  return { ok: true, pid: process.pid, file, release };
}

/**
 * Next wait between sync attempts. A 401/403 is terminal for this credential, so
 * the loop backs off to at least five minutes instead of retrying every interval;
 * transient failures (429/5xx/network) keep the configured interval. Pure, so the
 * regression test can assert it without waiting.
 */
export function nextSyncDelay(intervalMs, failure) {
  const terminal = failure?.kind === 'forbidden' || failure?.kind === 'unauthorized';
  return terminal ? Math.max(intervalMs, AUTH_RETRY_MS) : intervalMs;
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** One page of inference rows, newest first. */
export function requestLogsUrl(config, { since = 0, cursor = null, limit = PAGE_LIMIT } = {}) {
  const url = new URL(`${config.apiBase.replace(/\/$/u, '')}/request-logs`);
  url.searchParams.set('category', 'inference');
  url.searchParams.set('limit', String(limit));
  if (since > 0) url.searchParams.set('since', String(since));
  if (cursor !== null) url.searchParams.set('cursor', cursor);
  if (config.product) url.searchParams.set('product', String(config.product));
  return url;
}

/**
 * Read one page. 401/403 become a SyncAuthError: the body is a short tag such
 * as `{"_tag":"Forbidden"}`, and the actionable part is the hint, not the body.
 */
export async function fetchPage(config, key, { since = 0, cursor = null, limit = PAGE_LIMIT } = {}) {
  const url = requestLogsUrl(config, { since, cursor, limit });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      // A hung socket must not freeze the loop: the watchdog then sees a live
      // process that never updates the archive and cannot help.
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 429 || response.status >= 500) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (!response.ok) {
      const body = await response.text();
      const failure = describeSyncFailure(response.status, body);
      if (failure.kind === 'unauthorized' || failure.kind === 'forbidden') throw new SyncAuthError(failure);
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
    return await response.json();
  }
  throw new Error('request-logs: retries exhausted');
}

/**
 * Ask the console one cheap question and report which layer rejects the key.
 * Prints nothing secret and never touches the archive.
 */
export async function checkAuth(config, { log = console.log } = {}) {
  const key = readApiKey(config);
  if (key === null) {
    log(`[opencode] no OPENCODE_GO_API_KEY (env or ${config.credentials})`);
    return 4;
  }
  const response = await fetch(requestLogsUrl(config, { limit: 1 }), {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.text();
  if (response.ok) {
    log(`[opencode] auth ok: request-logs HTTP 200 (${config.apiBase})`);
    return 0;
  }
  const failure = describeSyncFailure(response.status, body);
  log(`[opencode] auth failed: request-logs HTTP ${failure.status} (${failure.kind}${failure.tag ? ` ${failure.tag}` : ''})`);
  log(`[opencode] ${failure.hint}`);
  return failure.kind === 'forbidden' ? 3 : 4;
}

/**
 * The console's own day totals (`/usage/cost-by-day`, UTC dates). Kept next to
 * our archive so the page can show "official says X" for the same window: the
 * console buckets by UTC day while the dashboard buckets by the local day, and
 * a 7-day window can differ by roughly one day boundary.
 */
export async function fetchConsoleTotals(config, key) {
  const base = config.apiBase.replace(/\/$/u, '');
  const getJson = async (path) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 429 || response.status >= 500) {
        await new Promise((done) => setTimeout(done, 400 * 2 ** attempt));
        continue;
      }
      if (!response.ok) {
        const failure = describeSyncFailure(response.status, await response.text());
        console.log(`[opencode] ${path} -> HTTP ${failure.status} (${failure.kind}${failure.tag ? ` ${failure.tag}` : ''})`);
        return null;
      }
      return response.json();
    }
    return null;
  };
  const [days, summary] = await Promise.all([getJson('/usage/cost-by-day'), getJson('/usage/summary')]);
  return {
    updatedAt: Date.now(),
    days: Array.isArray(days)
      ? days.map((day) => ({
          date: day.date,
          costUsd: Number(day.totalCostMicroCents || 0) / 1e8,
          requests: Number(day.totalRequests || 0),
        }))
      : [],
    summary: summary
      ? {
          costUsd: Number(summary.totalCostMicroCents || 0) / 1e8,
          requests: Number(summary.totalRequests || 0),
          inputTokens: Number(summary.totalInputTokens || 0),
          outputTokens: Number(summary.totalOutputTokens || 0),
          cacheReadTokens: Number(summary.totalCacheReadTokens || 0),
        }
      : null,
  };
}

function readState(store) {
  const file = `${store}/state.json`;
  if (!existsSync(file)) return { lastSyncAt: 0, lastUntil: 0, count: 0 };
  try {
    return { lastSyncAt: 0, lastUntil: 0, count: 0, ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    return { lastSyncAt: 0, lastUntil: 0, count: 0 };
  }
}

function writeState(store, state) {
  writeFileSync(`${store}/state.json`, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/**
 * Keep the last failure next to the archive so the page can explain a stale
 * number instead of only saying "the loop may have stopped". Diagnostics must
 * never break the loop, hence the swallow.
 */
function recordFailure(store, error) {
  try {
    const state = readState(store);
    const failure = error?.failure ?? null;
    state.lastError = {
      at: Date.now(),
      status: failure?.status ?? null,
      kind: failure?.kind ?? 'network',
      tag: failure?.tag ?? null,
      message: String(error instanceof Error ? error.message : error).slice(0, 300),
    };
    writeState(store, state);
  } catch {
    /* a broken state file is not worth stopping the sync for */
  }
}

/**
 * Pull every row newer than the stored watermark into `requests.jsonl`.
 * Returns a summary of what changed.
 */
export async function syncOnce(config, { full = false, dryRun = false, log = console.log } = {}) {
  const key = readApiKey(config);
  if (key === null) throw new Error(`no OPENCODE_GO_API_KEY (env or ${config.credentials})`);
  const store = config.store;
  if (!store) throw new Error('official.json has no opencode.store path');
  mkdirSync(store, { recursive: true });
  const file = `${store}/requests.jsonl`;
  const state = readState(store);
  // Overlap by five minutes: the console indexes rows with a little lag.
  const since = full || state.lastSyncAt === 0 ? 0 : Math.max(0, state.lastSyncAt - 5 * 60 * 1000);
  const existing = loadOfficialStore(store).records;
  const incoming = [];
  let cursor = null;
  let pages = 0;
  let lastUntil = state.lastUntil ?? 0;
  while (pages < MAX_PAGES) {
    const page = await fetchPage(config, key, { since, cursor });
    pages += 1;
    lastUntil = Number(page.until) || lastUntil;
    const items = Array.isArray(page.items) ? page.items : [];
    for (const raw of items) {
      const record = normalizeLogItem(raw);
      if (record !== null && record.startedAt >= since) incoming.push(record);
    }
    cursor = page.nextCursor ?? null;
    if (cursor === null || items.length === 0) break;
    if (items.length > 0 && Math.min(...items.map((item) => Number(item.startedAt) || Infinity)) < since) break;
  }
  const merged = mergeOfficialRecords(existing, incoming);
  if (!dryRun && (merged.added > 0 || merged.updated > 0)) {
    // Rewrite in sorted order: revisions must replace rows, not duplicate them.
    const temp = `${file}.tmp`;
    writeFileSync(temp, merged.records.map((record) => `${JSON.stringify(record)}\n`).join(''), 'utf8');
    renameSync(temp, file);
  }
  const summary = summarizeStore(merged.records);
  let consoleTotals = null;
  if (!dryRun) {
    try {
      consoleTotals = await fetchConsoleTotals(config, key);
    } catch (error) {
      log(`[opencode] console totals unavailable: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (!dryRun) {
    writeState(store, {
      lastSyncAt: Date.now(),
      lastUntil,
      count: merged.records.length,
      earliest: summary.earliest,
      newest: summary.newest,
      pages,
      console: consoleTotals ?? state.console ?? null,
      updatedAtISO: new Date().toISOString(),
    });
  }
  log(
    `[opencode] pages=${pages} fetched=${incoming.length} added=${merged.added} updated=${merged.updated} total=${summary.requests} sessions=${summary.sessions} usd=${summary.costUsd.toFixed(4)}`,
  );
  return { pages, fetched: incoming.length, added: merged.added, ...summary, store };
}

function parseArgs(argv) {
  const options = { loop: false, full: false, stats: false, dryRun: false, checkAuth: false, interval: 60, config: DEFAULT_CONFIG };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--loop') options.loop = true;
    else if (arg === '--full') options.full = true;
    else if (arg === '--stats') options.stats = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--check-auth') options.checkAuth = true;
    else if (arg === '--config') options.config = argv[++index];
    else if (arg === '--interval') options.interval = Number(argv[++index]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`opencode-sync: ${error.message}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write('usage: opencode-sync.mjs [--config <file>] [--loop] [--interval 60] [--full] [--stats] [--dry-run] [--check-auth]\n');
    return 0;
  }
  const config = loadOfficialConfig(options.config);
  if (config.missing) {
    process.stderr.write(`opencode-sync: missing ${options.config}\n`);
    return 2;
  }
  if (config.enabled === false) {
    process.stdout.write('[opencode] disabled in official.json\n');
    return 0;
  }
  if (options.checkAuth) return checkAuth(config);
  if (options.stats) {
    const store = loadOfficialStore(config.store);
    const summary = summarizeStore(store.records);
    process.stdout.write(`${JSON.stringify({ store: config.store, ...summary }, null, 2)}\n`);
    return 0;
  }
  if (!options.loop) {
    try {
      await syncOnce(config, { full: options.full, dryRun: options.dryRun });
      return 0;
    } catch (error) {
      process.stderr.write(`opencode-sync: ${error.message}\n`);
      return 1;
    }
  }
  const intervalMs = Math.max(15, options.interval || 60) * 1000;
  const lock = acquireStoreLock(config.store);
  if (!lock.ok) {
    process.stdout.write(`[opencode] another sync is already running (pid ${lock.pid}); exiting\n`);
    return 0;
  }
  // One line per state change: a rejected credential used to print every
  // minute, which buries the first (and only useful) line.
  let previousKind = null;
  for (;;) {
    let failure = null;
    try {
      await syncOnce(config, {});
      previousKind = null;
    } catch (error) {
      failure = error?.failure ?? null;
      const kind = failure?.kind ?? 'error';
      if (kind !== previousKind) {
        process.stderr.write(`[opencode] sync failed: ${error instanceof Error ? error.message : error}\n`);
      }
      previousKind = kind;
      recordFailure(config.store, error);
    }
    // A key the console refuses is not going to start working next minute.
    await sleep(nextSyncDelay(intervalMs, failure));
  }
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]).toLowerCase() === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')).toLowerCase();
if (invokedDirectly) {
  main().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
