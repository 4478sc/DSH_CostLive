/** Machine-readable report builders: JSON and CSV. */
import { isSubagentSession, projectionIsRunning, sortSessionRecords } from './activity.mjs';
import { resolvePrice } from './pricing.mjs';

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
    title: meta.title,
    cwd: meta.cwd,
    workspaceDir: meta.workspaceDir,
    agentPreset: meta.agentPreset,
    delegationDepth: meta.delegationDepth,
    origin: meta.origin ?? null,
    parentSession: meta.parentSession ?? null,
    running,
    isSubagent,
    createdAt: meta.createdAt,
    createdAtISO: meta.createdAt === null ? null : new Date(meta.createdAt).toISOString(),
    logPath: meta.logPath,
    totals: {
      ...analysis.totals.tokens,
      totalTokens: analysis.totals.totalTokens,
      costCny: round(analysis.totals.costCny),
      costMicroCny: analysis.totals.costMicroCny,
      cacheHit: analysis.totals.cacheHit === null ? null : round(analysis.totals.cacheHit, 4),
      samples: analysis.totals.samples,
    },
    models: analysis.byModel.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      priceKey: entry.priceKey,
      priced: entry.priced,
      tokens: { ...entry.tokens },
      costCny: round(entry.costCny),
      costMicroCny: entry.costMicroCny,
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
 */
export function buildTimeRangeDataset({ sessions, pricing, pageSize = 5 }) {
  return {
    pageSize,
    sessions: sessions.map((session) => {
      const models = session.models.map((model) => ({
        provider: model.provider ?? null,
        model: model.model ?? null,
        priced: model.priced === true,
        costMicroCny: model.costMicroCny,
        cacheSavingMicro: Math.round(modelCacheSavingMicro(model, pricing)),
        tokens: {
          uncachedInputTokens: model.tokens.uncachedInputTokens,
          outputTokens: model.tokens.outputTokens,
          cacheWriteTokens: model.tokens.cacheWriteTokens,
          cacheReadTokens: model.tokens.cacheReadTokens,
        },
      }));
      return {
        id: session.id,
        createdAt: typeof session.createdAt === 'number' ? session.createdAt : null,
        running: session.running === true,
        isSubagent: session.isSubagent === true,
        costMicroCny: session.totals.costMicroCny,
        cacheSavingMicro: models.reduce((sum, model) => sum + model.cacheSavingMicro, 0),
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
  };
}

/** Build the complete report object emitted by `--format json`. */
export function buildReport({ home, pricing, results, generatedAt }) {
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
      if (session.totals.costMicroCny > 0) acc.pricedSessions += 1;
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
    },
  );
  const billedInput = summary.inputTokens + summary.cacheWriteTokens + summary.cacheReadTokens;
  return {
    tool: 'dsh-cost',
    version: 1,
    generatedAt,
    generatedAtISO: new Date(generatedAt).toISOString(),
    home,
    currency: pricing.currency,
    unitTokens: pricing.unitTokens,
    pricing: {
      models: Object.fromEntries(Object.entries(pricing.models).map(([id, price]) => [id, { ...price }])),
      aliases: { ...pricing.aliases },
    },
    summary: {
      ...summary,
      costCny: round(summary.costMicroCny / 1e6),
      cacheHit: billedInput === 0 ? null : round(summary.cacheReadTokens / billedInput, 4),
      unpricedModels: [...new Set(sessions.flatMap((session) => session.unpricedModels))],
    },
    sessions,
  };
}

/** Escape one CSV field (RFC 4180). */
function csvField(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One row per session+model, plus a TOTAL row. */
export function toCsv(report) {
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
  ]);
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}
