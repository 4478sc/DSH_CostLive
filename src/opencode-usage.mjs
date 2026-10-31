/**
 * Official OpenCode usage: local archive + session overlay.
 *
 * The OpenCode console (`/console/api/request-logs?category=inference`) reports
 * the tokens and USD cost of every inference request, but only keeps 30 days.
 * `tools/opencode-sync.mjs` pulls those rows into an append-only local store;
 * this module reads that store and turns it into the same analysis shape the
 * DSH log fold produces, so the dashboard can show official numbers instead of
 * recomputed estimates.
 *
 * Matching is by session: official rows carry `sessionID` (the DSH session id),
 * which is what `x-opencode-session` sends upstream.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { addBuckets, billedInputTokens, zeroBuckets } from './pricing.mjs';

export const OFFICIAL_STORE_VERSION = 1;
export const DEFAULT_PROVIDERS = ['opencode', 'opencode-go'];

/** Session ids differ only by DSH's optional `session-` prefix upstream. */
export function sessionKey(id) {
  if (typeof id !== 'string') return '';
  return id.startsWith('session-') ? id.slice('session-'.length) : id;
}

function int(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Coerce one console row into the compact record kept on disk. */
export function normalizeLogItem(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : typeof raw.requestID === 'string' ? raw.requestID : null;
  if (id === null) return null;
  const startedAt = Number(raw.startedAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
  return {
    id,
    startedAt,
    finishedAt: Number(raw.finishedAt) || null,
    sessionID: typeof raw.sessionID === 'string' && raw.sessionID !== '' ? raw.sessionID : null,
    userID: typeof raw.userID === 'string' ? raw.userID : null,
    provider: typeof raw.provider === 'string' ? raw.provider : null,
    model: typeof raw.model === 'string' ? raw.model : (typeof raw.requestedModel === 'string' ? raw.requestedModel : null),
    product: typeof raw.product === 'string' ? raw.product : null,
    statusCode: Number(raw.statusCode) || null,
    outcome: typeof raw.outcome === 'string' ? raw.outcome : null,
    durationMs: Number(raw.durationMs) || 0,
    tokens: {
      uncachedInputTokens: int(raw.inputTokens),
      outputTokens: int(raw.outputTokens),
      cacheReadTokens: int(raw.cacheReadTokens),
      cacheWriteTokens: int(raw.cacheWriteTokens),
    },
    reasoningTokens: int(raw.reasoningTokens),
    costUsd: typeof raw.cost === 'number' && Number.isFinite(raw.cost) && raw.cost > 0 ? raw.cost : 0,
  };
}

/** Dedupe by request id; returns records sorted by start time. */
export function mergeOfficialRecords(existing, incoming) {
  const byId = new Map();
  for (const record of existing ?? []) byId.set(record.id, record);
  let added = 0;
  for (const record of incoming ?? []) {
    if (record === null || record === undefined) continue;
    if (byId.has(record.id)) continue;
    byId.set(record.id, record);
    added += 1;
  }
  const records = [...byId.values()].sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
  return { records, added };
}

/** Group records by normalized session id. */
export function groupBySession(records) {
  const map = new Map();
  for (const record of records) {
    if (record.sessionID === null) continue;
    const key = sessionKey(record.sessionID);
    if (key === '') continue;
    let list = map.get(key);
    if (list === undefined) {
      list = [];
      map.set(key, list);
    }
    list.push(record);
  }
  return map;
}

/** Total tokens in one record. */
export function recordTokens(record) {
  const t = record.tokens;
  return t.uncachedInputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
}

/**
 * Build the same analysis object `analyzeEvents` returns, from official rows.
 * Costs stay in USD (\`costMicroUsd\`); nothing is converted to CNY here.
 */
export function officialAnalysis(records) {
  const billed = (records ?? []).filter((record) => recordTokens(record) > 0);
  const totalsBuckets = zeroBuckets();
  const models = new Map();
  let totalMicroUsd = 0;

  for (const record of billed) {
    const costMicroUsd = Math.round(record.costUsd * 1e6);
    addBuckets(totalsBuckets, record.tokens);
    totalMicroUsd += costMicroUsd;
    const key = `${record.provider ?? '?'}\u0000${record.model ?? '?'}`;
    let model = models.get(key);
    if (model === undefined) {
      model = {
        provider: record.provider,
        model: record.model,
        priceKey: 'opencode-official',
        priced: true,
        tokens: zeroBuckets(),
        costMicroCny: 0,
        costMicroUsd: 0,
        samples: 0,
      };
      models.set(key, model);
    }
    addBuckets(model.tokens, record.tokens);
    model.costMicroUsd += costMicroUsd;
    model.samples += 1;
  }

  const byModel = [...models.values()]
    .map((entry) => ({
      ...entry,
      costCny: 0,
      costUsd: entry.costMicroUsd / 1e6,
      share: totalMicroUsd === 0 ? 0 : entry.costMicroUsd / totalMicroUsd,
    }))
    .sort((a, b) => b.costMicroUsd - a.costMicroUsd);

  const recordsOut = billed.map((record) => ({
    time: record.startedAt,
    provider: record.provider,
    model: record.model,
    priceKey: 'opencode-official',
    priced: true,
    buckets: { ...record.tokens },
    costMicroCny: 0,
    costMicroUsd: Math.round(record.costUsd * 1e6),
    official: true,
  }));

  return {
    records: recordsOut,
    totals: {
      tokens: totalsBuckets,
      totalTokens: totalsBuckets.uncachedInputTokens + totalsBuckets.outputTokens + totalsBuckets.cacheReadTokens + totalsBuckets.cacheWriteTokens,
      costMicroCny: 0,
      costCny: 0,
      costMicroUsd: totalMicroUsd,
      costUsd: totalMicroUsd / 1e6,
      billedInputTokens: billedInputTokens(totalsBuckets),
      cacheHit:
        billedInputTokens(totalsBuckets) === 0 ? null : totalsBuckets.cacheReadTokens / billedInputTokens(totalsBuckets),
      samples: recordsOut.length,
    },
    byModel,
    byTurn: [],
    unpricedModels: [],
    warnings: [],
    official: { requests: recordsOut.length, costUsd: totalMicroUsd / 1e6 },
  };
}

function providerAllowed(provider, providers) {
  if (provider === null || provider === undefined) return true;
  return providers.some((allowed) => String(provider).toLowerCase().startsWith(String(allowed).toLowerCase()));
}

/**
 * Replace locally folded numbers with official ones for every session that has
 * official rows and whose local models all belong to the official provider set.
 * Mixed sessions (e.g. DeepSeek next to Claude in one session) are left alone.
 */
export function applyOfficialOverlay(results, { records, providers = DEFAULT_PROVIDERS } = {}) {
  const bySession = groupBySession(records ?? []);
  const stats = { applied: 0, skippedMixed: 0, sessions: bySession.size, records: (records ?? []).length, costUsd: 0 };
  for (const result of results) {
    const key = sessionKey(result.meta?.id ?? '');
    const rows = bySession.get(key);
    if (rows === undefined || rows.length === 0) continue;
    const localProviders = new Set((result.analysis?.byModel ?? []).map((entry) => entry.provider).filter(Boolean));
    const mixed = [...localProviders].some((provider) => !providerAllowed(provider, providers));
    if (mixed) {
      stats.skippedMixed += 1;
      continue;
    }
    result.localAnalysis ??= result.analysis;
    result.analysis = officialAnalysis(rows);
    result.official = result.analysis.official;
    if (result.meta && typeof result.meta === 'object') result.meta.official = true;
    result.meta.officialCostUsd = rows.reduce((sum, record) => sum + record.costUsd, 0);
    stats.applied += 1;
  }
  return stats;
}

/** Parse cache keyed on (mtime, size): the live server re-reads every 20s. */
const storeCache = new Map();

/** Read `requests.jsonl` from a store directory (missing store => empty). */
export function loadOfficialStore(storeDir) {
  const file = `${storeDir}/requests.jsonl`;
  if (!existsSync(file)) return { records: [], file, missing: true };
  const info = statSync(file);
  const cached = storeCache.get(file);
  if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return { records: cached.records, file, missing: false };
  }
  const text = readFileSync(file, 'utf8');
  const records = [];
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record.id === 'string' && Number.isFinite(record.startedAt)) records.push(record);
    } catch {
      /* a torn tail line from an interrupted append is skipped */
    }
  }
  storeCache.set(file, { mtimeMs: info.mtimeMs, size: info.size, records });
  return { records, file, missing: false };
}

/** Coarse store summary for headers and health output. */
export function summarizeStore(records) {
  if (records.length === 0) return { requests: 0, sessions: 0, earliest: null, newest: null, costUsd: 0, tokens: 0 };
  let earliest = Infinity;
  let newest = 0;
  let costUsd = 0;
  let tokens = 0;
  for (const record of records) {
    earliest = Math.min(earliest, record.startedAt);
    newest = Math.max(newest, record.startedAt);
    costUsd += record.costUsd ?? 0;
    tokens += recordTokens(record);
  }
  return { requests: records.length, sessions: groupBySession(records).size, earliest, newest, costUsd, tokens };
}

/** Expand `~` and relative paths against a base directory. */
export function expandPath(value, baseDir) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let text = value.trim();
  if (text === '~') text = homedir();
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = resolve(homedir(), text.slice(2));
  return isAbsolute(text) ? resolve(text) : resolve(baseDir, text);
}

export const DEFAULT_OFFICIAL_CONFIG = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')), '..', 'config', 'official.json');

/**
 * Read `config/official.json`. Shape:
 *   { "opencode": { "enabled": true, "store": "../../.opencode-usage",
 *                   "providers": ["opencode"],
 *                   "credentials": "~/.dsh/.credentials.yaml" } }
 * Relative `store`/`credentials` paths resolve against the JSON file.
 */
export function loadOfficialConfig(path = DEFAULT_OFFICIAL_CONFIG) {
  const file = resolve(path);
  const fallback = {
    file,
    missing: true,
    enabled: true,
    store: null,
    providers: DEFAULT_PROVIDERS,
    apiBase: 'https://opencode.ai/console/api',
    credentials: expandPath('~/.dsh/.credentials.yaml', process.cwd()),
    product: null,
  };
  if (!existsSync(file)) return fallback;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot parse ${file}: ${error.message}`);
  }
  const opencode = parsed?.opencode ?? parsed ?? {};
  const baseDir = dirname(file);
  return {
    ...fallback,
    ...opencode,
    file,
    missing: false,
    store: expandPath(opencode.store ?? '../../.opencode-usage', baseDir),
    credentials: expandPath(opencode.credentials ?? '~/.dsh/.credentials.yaml', baseDir),
    providers: Array.isArray(opencode.providers) && opencode.providers.length > 0 ? opencode.providers : DEFAULT_PROVIDERS,
  };
}

/** `refs:` entries in the DSH credential store are plain `KEY: value` lines. */
export function readApiKey(config) {
  const env = process.env.OPENCODE_GO_API_KEY;
  if (typeof env === 'string' && env.trim() !== '') return env.trim();
  const file = config?.credentials;
  if (!file || !existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const match = /^\s*OPENCODE_GO_API_KEY:\s*(\S+)\s*$/mu.exec(text);
  return match ? match[1] : null;
}

/**
 * Load the archive for reporting. Returns null when official data is disabled,
 * the config file is absent, or the store has no rows yet.
 */
export function loadOfficialReport({ officialPath, enabled = true } = {}) {
  if (enabled === false) return null;
  const config = loadOfficialConfig(officialPath ?? DEFAULT_OFFICIAL_CONFIG);
  if (config.missing || config.enabled === false || !config.store) return null;
  const { records } = loadOfficialStore(config.store);
  if (records.length === 0) return null;
  return { config, records, summary: summarizeStore(records) };
}
