/** Machine-readable report builders: JSON and CSV. */
import { isSubagentSession, projectionIsRunning, sortSessionRecords } from './activity.mjs';
import { canonicalProvider, DEFAULT_USD_LONG_CONTEXT_THRESHOLD, resolvePrice } from './pricing.mjs';
import { averageTokenPrice, sortCostMicro } from './money.mjs';
import { formatDay, localMidnight } from './time-range.mjs';
import { attachBilling, realPricingCsv } from './billing-report.mjs';

/** Round a float for stable JSON output. */
function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Convert one analysis into a JSON-safe session record. */
export function sessionRecord({ meta, analysis, projection }) {
  const running = typeof meta.running === 'boolean' ? meta.running : projectionIsRunning(projection);
  const isSubagent = typeof meta.isSubagent === 'boolean' ? meta.isSubagent : isSubagentSession(meta, projection);
  return {
    id: meta.id,
    uid: meta.source ? `${meta.source}:${meta.id}` : meta.id,
    source: meta.source ?? null,
    sourceHome: meta.sourceHome ?? null,
    title: meta.title,
    cwd: meta.cwd,
    workspaceDir: meta.workspaceDir,
    agentPreset: meta.agentPreset,
    delegationDepth: meta.delegationDepth,
    origin: meta.origin ?? null,
    parentSession: meta.parentSession ?? null,
    running,
    isSubagent,
    official: meta.official === true,
    officialPending:
      meta.official !== true &&
      (analysis.pendingModels?.length ?? 0) > 0 &&
      (analysis.totals.costMicroCny ?? 0) === 0 &&
      (analysis.totals.costMicroUsd ?? 0) === 0,
    pendingModels: analysis.pendingModels ?? [],
    createdAt: meta.createdAt,
    createdAtISO: meta.createdAt === null ? null : new Date(meta.createdAt).toISOString(),
    logPath: meta.logPath,
    totals: {
      ...analysis.totals.tokens,
      totalTokens: analysis.totals.totalTokens,
      costCny: round(analysis.totals.costCny),
      costMicroCny: analysis.totals.costMicroCny,
      costUsd: round(analysis.totals.costUsd ?? 0),
      costMicroUsd: analysis.totals.costMicroUsd ?? 0,
      cacheHit: analysis.totals.cacheHit === null ? null : round(analysis.totals.cacheHit, 4),
      samples: analysis.totals.samples,
    },
    models: analysis.byModel.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      tier: entry.tier ?? null,
      priceKey: entry.priceKey,
      priced: entry.priced,
      tokens: { ...entry.tokens },
      costCny: round(entry.costCny),
      costMicroCny: entry.costMicroCny,
      costUsd: round(entry.costUsd ?? 0),
      costMicroUsd: entry.costMicroUsd ?? 0,
      cacheSavingMicroUsd: entry.cacheSavingMicroUsd ?? 0,
      share: round(entry.share, 4),
      samples: entry.samples,
    })),
    turns: analysis.byTurn.map((entry) => ({
      turn: entry.turn,
      steps: entry.steps,
      tokens: { ...entry.tokens },
      totalTokens: entry.totalTokens,
      costCny: round(entry.costCny),
      costMicroCny: entry.costMicroCny,
      costUsd: round(entry.costUsd ?? 0),
      costMicroUsd: entry.costMicroUsd ?? 0,
      cacheHit: entry.cacheHit === null ? null : round(entry.cacheHit, 4),
    })),
    unpricedModels: analysis.unpricedModels,
    projectionTokenUsage: projection?.tokenUsage?.totals ?? null,
  };
}

/**
 * Cache saving (micro-CNY) for one session-model entry: the cache-read tokens
 * priced at the full input rate instead of the cache-read rate. Returns 0 for
 * unpriced models, exactly like the report's aggregate.
 */
export function modelCacheSavingMicro(model, pricing) {
  const resolved = resolvePrice(model.model, pricing);
  if (resolved === null) return 0;
  return model.tokens.cacheReadTokens * (resolved.price.input - resolved.price.cacheRead);
}

/** Empty four-bucket token record. */
function emptyTokens() {
  return { uncachedInputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
}

/** Sum of the four buckets. */
function tokensTotal(tokens) {
  return (
    tokens.uncachedInputTokens + tokens.outputTokens + tokens.cacheWriteTokens + tokens.cacheReadTokens
  );
}

/**
 * Aggregate billed samples by local calendar day.
 *
 * Unlike the session list (which groups by `session.createdAt`), every sample
 * keeps its own `event.time`; a session that runs past midnight therefore
 * contributes to both days with only that day's tokens and cost. The sum of all
 * day buckets equals the session totals, so nothing is double counted.
 *
 * Samples without a usable timestamp land in a synthetic "unknown" bucket
 * (`dayStart: 0`), which only the All-time view shows.
 */
export function buildDailyReport(results, pricing) {
  const days = new Map();

  const dayEntry = (dayStart) => {
    let entry = days.get(dayStart);
    if (entry === undefined) {
      entry = {
        day: dayStart > 0 ? formatDay(dayStart) : 'unknown',
        dayStart,
        unknown: dayStart <= 0,
        totals: { ...emptyTokens(), totalTokens: 0, costMicroCny: 0, costMicroUsd: 0, cacheSavingMicro: 0, cacheSavingMicroUsd: 0, samples: 0, cacheHit: null },
        sessions: new Map(),
      };
      days.set(dayStart, entry);
    }
    return entry;
  };

  for (const result of results) {
    const meta = result.meta ?? {};
    const records = result.analysis?.records ?? [];
    for (const record of records) {
      const hasTime = typeof record.time === 'number' && Number.isFinite(record.time) && record.time > 0;
      const day = dayEntry(hasTime ? localMidnight(record.time) : 0);
      const buckets = record.buckets ?? emptyTokens();
      const total = tokensTotal(buckets);

      day.totals.uncachedInputTokens += buckets.uncachedInputTokens;
      day.totals.outputTokens += buckets.outputTokens;
      day.totals.cacheWriteTokens += buckets.cacheWriteTokens;
      day.totals.cacheReadTokens += buckets.cacheReadTokens;
      day.totals.totalTokens += total;
      day.totals.costMicroCny += record.costMicroCny ?? 0;
      day.totals.costMicroUsd += record.costMicroUsd ?? 0;
      day.totals.samples += 1;

      // Key on source+id: two sources can hold the same session id, and the
      // insert below has to use the same key the lookup uses.
      const sessionKey = `${meta.source ?? ''}\u0000${meta.id}`;
      let session = day.sessions.get(sessionKey);
      if (session === undefined) {
        session = {
          id: meta.id,
          uid: meta.source ? `${meta.source}:${meta.id}` : meta.id,
          source: meta.source ?? null,
          title: meta.title ?? null,
          running: meta.running === true,
          isSubagent: meta.isSubagent === true,
          costMicroCny: 0,
          costMicroUsd: 0,
          samples: 0,
          tokens: emptyTokens(),
          models: new Map(),
        };
        day.sessions.set(sessionKey, session);
      }
      session.costMicroCny += record.costMicroCny ?? 0;
      session.costMicroUsd += record.costMicroUsd ?? 0;
      session.samples += 1;
      session.tokens.uncachedInputTokens += buckets.uncachedInputTokens;
      session.tokens.outputTokens += buckets.outputTokens;
      session.tokens.cacheWriteTokens += buckets.cacheWriteTokens;
      session.tokens.cacheReadTokens += buckets.cacheReadTokens;

      const modelProvider = canonicalProvider(record.provider);
      const modelKey = `${modelProvider ?? '?'}\u0000${record.model ?? '?'}\u0000${record.tier ?? ''}`;
      let model = session.models.get(modelKey);
      if (model === undefined) {
        model = {
          provider: modelProvider,
          model: record.model ?? null,
          tier: record.tier ?? null,
          priceKey: record.priceKey ?? null,
          priced: record.priced === true,
          costMicroCny: 0,
          costMicroUsd: 0,
          cacheSavingMicro: 0,
          cacheSavingMicroUsd: 0,
          tokens: emptyTokens(),
        };
        session.models.set(modelKey, model);
      }
      // A group can hold both official and still-pending rows; the official
      // marker wins so the row shows money instead of 「待官网」.
      if (record.priceKey === 'opencode-official' && model.priceKey !== 'opencode-official') {
        model.priceKey = 'opencode-official';
        model.priced = true;
      }
      model.costMicroCny += record.costMicroCny ?? 0;
      model.costMicroUsd += record.costMicroUsd ?? 0;
      model.tokens.uncachedInputTokens += buckets.uncachedInputTokens;
      model.tokens.outputTokens += buckets.outputTokens;
      model.tokens.cacheWriteTokens += buckets.cacheWriteTokens;
      model.tokens.cacheReadTokens += buckets.cacheReadTokens;

      // Official console rows and USD-list rows (codex) both carry micro-USD
      // cache savings; only CNY-priced rows are re-derived from the CNY table.
      const usdRow =
        record.priceKey === 'opencode-official' ||
        (typeof record.priceKey === 'string' && record.priceKey.startsWith('usd-'));
      const resolved = !usdRow && record.priced === true ? resolvePrice(record.model, pricing) : null;
      if (usdRow) {
        model.cacheSavingMicroUsd += record.cacheSavingMicroUsd ?? 0;
      } else if (resolved !== null) {
        // Same formula as modelCacheSavingMicro(), rounded per day+model so the
        // browser's integer sum reproduces the server number.
        model.cacheSavingMicro += Math.round(
          buckets.cacheReadTokens * (resolved.price.input - resolved.price.cacheRead),
        );
      }
    }
  }

  const out = [];
  for (const entry of days.values()) {
    const sessions = [...entry.sessions.values()]
      .map((session) => ({
        id: session.id,
        uid: session.uid,
        source: session.source ?? null,
        title: session.title,
        running: session.running,
        isSubagent: session.isSubagent,
        costMicroCny: session.costMicroCny,
        costMicroUsd: session.costMicroUsd,
        samples: session.samples,
        tokens: { ...session.tokens, totalTokens: tokensTotal(session.tokens) },
        models: [...session.models.values()]
          .map((model) => ({
            provider: model.provider,
            model: model.model,
            tier: model.tier ?? null,
            priceKey: model.priceKey ?? null,
            priced: model.priced,
            costMicroCny: model.costMicroCny,
            costMicroUsd: model.costMicroUsd,
            cacheSavingMicro: model.cacheSavingMicro,
            cacheSavingMicroUsd: model.cacheSavingMicroUsd,
            tokens: { ...model.tokens, totalTokens: tokensTotal(model.tokens) },
          }))
          .sort((a, b) => sortCostMicro(b) - sortCostMicro(a)),
      }))
      .sort((a, b) => sortCostMicro(b) - sortCostMicro(a) || String(a.title ?? '').localeCompare(String(b.title ?? '')));

    let cacheSavingMicro = 0;
    let cacheSavingMicroUsd = 0;
    for (const session of sessions) {
      for (const model of session.models) {
        cacheSavingMicro += model.cacheSavingMicro;
        cacheSavingMicroUsd += model.cacheSavingMicroUsd;
      }
    }
    const billedInput =
      entry.totals.uncachedInputTokens + entry.totals.cacheWriteTokens + entry.totals.cacheReadTokens;
    entry.totals.cacheSavingMicro = cacheSavingMicro;
    entry.totals.cacheSavingMicroUsd = cacheSavingMicroUsd;
    entry.totals.cacheHit =
      billedInput === 0 ? null : Math.round((entry.totals.cacheReadTokens / billedInput) * 10000) / 10000;

    out.push({
      day: entry.day,
      dayStart: entry.dayStart,
      unknown: entry.unknown,
      totals: entry.totals,
      sessions,
    });
  }

  out.sort((a, b) => b.dayStart - a.dayStart);
  return { days: out };
}

/**
 * Compact per-session dataset embedded in the HTML report.
 *
 * The client uses it to recompute the summary cards and the per-model table for
 * any time range without a round trip. Cache savings are rounded per model so
 * the client's integer sums match the server-rendered total exactly.
 *
 * @param {object} options
 * @param {object[]} options.sessions - built session records (already sorted).
 * @param {object} options.pricing - normalized pricing document.
 * @param {number} [options.pageSize] - rows rendered before "show more".
 * @param {object} [options.daily] - daily buckets from buildDailyReport().
 */
export function buildTimeRangeDataset({ sessions, pricing, pageSize = 5, daily }) {
  return {
    pageSize,
    sessions: sessions.map((session) => {
      const models = session.models.map((model) => ({
        provider: model.provider ?? null,
        model: model.model ?? null,
        tier: model.tier ?? null,
        priceKey: model.priceKey ?? null,
        priced: model.priced === true,
        costMicroCny: model.costMicroCny,
        costMicroUsd: model.costMicroUsd ?? 0,
        cacheSavingMicro: model.priceKey === 'opencode-official' ? 0 : Math.round(modelCacheSavingMicro(model, pricing)),
        cacheSavingMicroUsd: model.cacheSavingMicroUsd ?? 0,
        tokens: {
          uncachedInputTokens: model.tokens.uncachedInputTokens,
          outputTokens: model.tokens.outputTokens,
          cacheWriteTokens: model.tokens.cacheWriteTokens,
          cacheReadTokens: model.tokens.cacheReadTokens,
        },
      }));
      return {
        id: session.id,
        uid: session.uid ?? session.id,
        source: session.source ?? null,
        createdAt: typeof session.createdAt === 'number' ? session.createdAt : null,
        running: session.running === true,
        isSubagent: session.isSubagent === true,
        costMicroCny: session.totals.costMicroCny,
        costMicroUsd: session.totals.costMicroUsd ?? 0,
        cacheSavingMicro: models.reduce((sum, model) => sum + model.cacheSavingMicro, 0),
        cacheSavingMicroUsd: models.reduce((sum, model) => sum + model.cacheSavingMicroUsd, 0),
        tokens: {
          uncachedInputTokens: session.totals.uncachedInputTokens,
          outputTokens: session.totals.outputTokens,
          cacheWriteTokens: session.totals.cacheWriteTokens,
          cacheReadTokens: session.totals.cacheReadTokens,
          totalTokens: session.totals.totalTokens,
        },
        models,
      };
    }),
    days: (daily?.days ?? []).map((day) => ({
      day: day.day,
      dayStart: day.dayStart,
      unknown: day.unknown === true,
      totals: {
        uncachedInputTokens: day.totals.uncachedInputTokens,
        outputTokens: day.totals.outputTokens,
        cacheWriteTokens: day.totals.cacheWriteTokens,
        cacheReadTokens: day.totals.cacheReadTokens,
        totalTokens: day.totals.totalTokens,
        costMicroCny: day.totals.costMicroCny,
        costMicroUsd: day.totals.costMicroUsd ?? 0,
        cacheSavingMicro: day.totals.cacheSavingMicro,
        cacheSavingMicroUsd: day.totals.cacheSavingMicroUsd ?? 0,
        samples: day.totals.samples,
        cacheHit: day.totals.cacheHit,
      },
      sessions: day.sessions.map((session) => ({
        id: session.id,
        uid: session.uid ?? session.id,
        source: session.source ?? null,
        title: session.title,
        running: session.running === true,
        isSubagent: session.isSubagent === true,
        costMicroCny: session.costMicroCny,
        costMicroUsd: session.costMicroUsd ?? 0,
        samples: session.samples,
        tokens: { ...session.tokens },
        models: session.models.map((model) => ({
          provider: model.provider ?? null,
          model: model.model ?? null,
          tier: model.tier ?? null,
          priceKey: model.priceKey ?? null,
          priced: model.priced === true,
          costMicroCny: model.costMicroCny,
          costMicroUsd: model.costMicroUsd ?? 0,
          cacheSavingMicro: model.cacheSavingMicro,
          cacheSavingMicroUsd: model.cacheSavingMicroUsd ?? 0,
          tokens: { ...model.tokens },
        })),
      })),
    })),
  };
}

/**
 * JSON-safe provenance copy of the USD table for report consumers.
 *
 * Legacy reports (no USD document) keep `usdPricing: null`, so old reports
 * and fixtures keep rendering exactly as before.
 */
function usdPricingRecord(usdPricing) {
  if (usdPricing === null || usdPricing === undefined) return null;
  const models = {};
  for (const [id, price] of Object.entries(usdPricing.models)) {
    models[id] = {
      ...price,
      source: price.source ?? 'legacy',
      ...(price.long === undefined ? {} : { long: { ...price.long } }),
    };
  }
  const providers = [...(usdPricing.providers ?? [])];
  return {
    currency: 'USD',
    unitTokens: usdPricing.unitTokens,
    longContextThreshold: usdPricing.longContextThreshold ?? DEFAULT_USD_LONG_CONTEXT_THRESHOLD,
    providers,
    canonicalProviders: [...new Set(providers.map((provider) => canonicalProvider(provider)))],
    source: usdPricing.source === null || usdPricing.source === undefined ? null : { ...usdPricing.source },
    models,
    aliases: { ...usdPricing.aliases },
  };
}

/** Build the complete report object emitted by `--format json`. */
export function buildReport({ home, sources = [], pricing, usdPricing = null, results, generatedAt, billing, billingBounds }) {
  const sessions = results.map(sessionRecord);
  // Running main -> running subagent -> completed (cost/time order within each
  // bucket). buildReport is shared by the CLI, JSON/CSV output, and the live
  // dashboard, so sorting here keeps every surface consistent.
  sortSessionRecords(sessions);
  const summary = sessions.reduce(
    (acc, session) => {
      acc.sessions += 1;
      acc.inputTokens += session.totals.uncachedInputTokens;
      acc.outputTokens += session.totals.outputTokens;
      acc.cacheWriteTokens += session.totals.cacheWriteTokens;
      acc.cacheReadTokens += session.totals.cacheReadTokens;
      acc.totalTokens += session.totals.totalTokens;
      acc.costMicroCny += session.totals.costMicroCny;
      acc.costMicroUsd += session.totals.costMicroUsd;
      if (session.totals.costMicroCny > 0 || session.totals.costMicroUsd > 0) acc.pricedSessions += 1;
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
      costMicroUsd: 0,
    },
  );
  const billedInput = summary.inputTokens + summary.cacheWriteTokens + summary.cacheReadTokens;
  // Average price per 1M tokens over priced tokens only (CNY and USD apart).
  const tokenPrice = averageTokenPrice(sessions.flatMap((session) => session.models));
  summary.tokenPrice = {
    cnyMicroPerM: tokenPrice.cnyMicroPerM,
    usdMicroPerM: tokenPrice.usdMicroPerM,
    cnyTokens: tokenPrice.cnyTokens,
    usdTokens: tokenPrice.usdTokens,
  };
  const report = {
    tool: 'dsh-cost',
    version: 1,
    generatedAt,
    generatedAtISO: new Date(generatedAt).toISOString(),
    home,
    currency: pricing.currency,
    currencies: ['CNY', 'USD'],
    unitTokens: pricing.unitTokens,
    pricing: {
      models: Object.fromEntries(Object.entries(pricing.models).map(([id, price]) => [id, { ...price }])),
      aliases: { ...pricing.aliases },
    },
    // Separate currency, separate table: never merged into `pricing` (CNY).
    usdPricing: usdPricingRecord(usdPricing),
    summary: {
      ...summary,
      costCny: round(summary.costMicroCny / 1e6),
      costUsd: round(summary.costMicroUsd / 1e6),
      cacheHit: billedInput === 0 ? null : round(summary.cacheReadTokens / billedInput, 4),
      unpricedModels: [...new Set(sessions.flatMap((session) => session.unpricedModels))],
      pendingSessions: sessions.filter((session) => session.officialPending === true).length,
      pendingModels: [...new Set(sessions.flatMap((session) => session.pendingModels ?? []))],
    },
    sessions,
    daily: buildDailyReport(results, pricing),
    sources: sources.map((source) => ({
      label: source.label,
      home: source.home,
      sessions: source.sessions ?? 0,
      error: source.error ?? null,
    })),
  };
  return billing ? attachBilling(report, results, billing, billingBounds) : report;
}

/** Escape one CSV field (RFC 4180). */
function csvField(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One row per session+model, plus a TOTAL row. */
export function toCsv(report) {
  if (report.realPricing) return realPricingCsv(report);
  const header = [
    'session_id',
    'title',
    'cwd',
    'created_at',
    'agent_preset',
    'provider',
    'model',
    'priced',
    'input_tokens',
    'output_tokens',
    'cache_write_tokens',
    'cache_read_tokens',
    'cost_cny',
    'cost_usd',
  ];
  const rows = [header];
  for (const session of report.sessions) {
    if (session.models.length === 0) {
      rows.push([
        session.id,
        session.title ?? '',
        session.cwd ?? '',
        session.createdAtISO ?? '',
        session.agentPreset ?? '',
        '',
        '',
        'false',
        0,
        0,
        0,
        0,
        0,
        0,
      ]);
      continue;
    }
    for (const model of session.models) {
      rows.push([
        session.id,
        session.title ?? '',
        session.cwd ?? '',
        session.createdAtISO ?? '',
        session.agentPreset ?? '',
        model.provider ?? '',
        model.model ?? '',
        String(model.priced),
        model.tokens.uncachedInputTokens,
        model.tokens.outputTokens,
        model.tokens.cacheWriteTokens,
        model.tokens.cacheReadTokens,
        model.costCny.toFixed(6),
        (model.costUsd ?? 0).toFixed(6),
      ]);
    }
  }
  rows.push([
    'TOTAL',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    report.summary.inputTokens,
    report.summary.outputTokens,
    report.summary.cacheWriteTokens,
    report.summary.cacheReadTokens,
    report.summary.costCny.toFixed(6),
    report.summary.costUsd.toFixed(6),
  ]);
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}
