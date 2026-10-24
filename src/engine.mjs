/**
 * The cost fold.
 *
 * DSH's own `tokenUsage` projection counts provider-reported usage from each
 * attempt: a later `assistant/message` sample replaces the streaming sample of
 * the same turn/step, `llm/retry-started` closes that replacement scope, and a
 * retried attempt therefore contributes a second billed sample. This module
 * reproduces exactly that rule while recording WHICH model route each sample
 * was billed against, because prices are per model while a session may switch
 * models between turns (or even mid-step).
 *
 * Record semantics make the totals exact without delta subtraction: one record
 * per billed attempt; a replacement overwrites its record; a retry appends.
 */
import { addBuckets, billedInputTokens, costMicroCny, resolvePrice, zeroBuckets } from './pricing.mjs';

/** The last provider usage sample embedded in an assistant settlement's stream. */
export function usageFromEvent(event) {
  if (event.type === 'assistant/message') {
    const value = event.data?.usage;
    if (value !== undefined && value !== null && typeof value === 'object') return value;
  } else if (event.type !== 'assistant/attempt') {
    return undefined;
  }
  const stream = event.data?.stream;
  if (!Array.isArray(stream)) return undefined;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage;
  }
  return undefined;
}

/** Coerce provider usage into non-negative integer buckets. */
export function bucketsFromUsage(usage) {
  const pick = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
  return {
    uncachedInputTokens: pick(usage.inputTokens),
    outputTokens: pick(usage.outputTokens),
    cacheReadTokens: pick(usage.cacheReadTokens),
    cacheWriteTokens: pick(usage.cacheWriteTokens),
  };
}

/** Bucket equality, matching the token-usage projection's replacement gate. */
export function bucketsEqual(left, right) {
  return (
    left.uncachedInputTokens === right.uncachedInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens
  );
}

/** Sum of all four buckets. */
export function totalTokens(buckets) {
  return buckets.uncachedInputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens;
}

/**
 * Fold one session's events into billed attempt records and aggregates.
 * @param events - parsed durable events in seq order.
 * @param pricing - normalized pricing document.
 * @returns per-model, per-turn, and whole-session cost figures.
 */
export function analyzeEvents(events, pricing) {
  const records = [];
  const warnings = [];
  let active = { provider: null, model: null };
  let last = null; // { turn, step, index } — replacement scope inside one attempt
  let samples = 0;

  for (const event of events) {
    switch (event.type) {
      case 'request/header': {
        const config = event.data?.header?.config;
        if (config && typeof config.model === 'string') {
          active = { provider: typeof config.provider === 'string' ? config.provider : active.provider, model: config.model };
        }
        continue;
      }
      case 'model/selection': {
        if (typeof event.data?.model === 'string') {
          active = {
            provider: typeof event.data.provider === 'string' ? event.data.provider : active.provider,
            model: event.data.model,
          };
        }
        continue;
      }
      case 'llm/retry-started': {
        if (last !== null && last.turn === event.data?.turn && last.step === event.data?.step) last = null;
        continue;
      }
      default: {
        const usage = usageFromEvent(event);
        if (usage === undefined) continue;
        samples += 1;
        const buckets = bucketsFromUsage(usage);
        const turn = Number.isInteger(event.data?.turn) ? event.data.turn : 0;
        const step = Number.isInteger(event.data?.step) ? event.data.step : 0;
        const resolved = resolvePrice(active.model, pricing);
        const record = {
          seq: event.seq,
          time: event.time,
          turn,
          step,
          provider: active.provider,
          model: active.model,
          priceKey: resolved?.key ?? null,
          priced: resolved !== null,
          buckets,
          // `event.time` selects the tier: two-tier models (DeepSeek) bill
          // off-peak samples at the discounted rate of the sample's own clock.
          costMicroCny: resolved === null ? 0 : costMicroCny(buckets, resolved.price, event.time),
        };
        if (!resolved && active.model) warnings.push(`no price for model "${active.model}" (provider ${active.provider ?? 'unknown'})`);
        if (last !== null && last.turn === turn && last.step === step) {
          if (bucketsEqual(records[last.index].buckets, buckets)) continue;
          records[last.index] = record;
        } else {
          records.push(record);
          last = { turn, step, index: records.length - 1 };
        }
      }
    }
  }

  // Zero-token settlements keep their replacement role above but must not
  // create model rows, warnings, or billed-sample counts.
  const billed = records.filter((record) => totalTokens(record.buckets) > 0);
  const totalsBuckets = zeroBuckets();
  let totalMicro = 0;
  const models = new Map();
  const turns = new Map();
  for (const record of billed) {
    addBuckets(totalsBuckets, record.buckets);
    totalMicro += record.costMicroCny;
    const modelKey = `${record.provider ?? '?'}\u0000${record.model ?? '?'}`;
    let modelEntry = models.get(modelKey);
    if (modelEntry === undefined) {
      modelEntry = {
        provider: record.provider,
        model: record.model,
        priceKey: record.priceKey,
        priced: record.priced,
        tokens: zeroBuckets(),
        costMicroCny: 0,
        samples: 0,
      };
      models.set(modelKey, modelEntry);
    }
    addBuckets(modelEntry.tokens, record.buckets);
    modelEntry.costMicroCny += record.costMicroCny;
    modelEntry.samples += 1;
    let turnEntry = turns.get(record.turn);
    if (turnEntry === undefined) {
      turnEntry = { turn: record.turn, tokens: zeroBuckets(), costMicroCny: 0, steps: 0 };
      turns.set(record.turn, turnEntry);
    }
    addBuckets(turnEntry.tokens, record.buckets);
    turnEntry.costMicroCny += record.costMicroCny;
    turnEntry.steps += 1;
  }

  const byModel = [...models.values()]
    .map((entry) => ({
      ...entry,
      costCny: entry.costMicroCny / 1e6,
      share: totalMicro === 0 ? 0 : entry.costMicroCny / totalMicro,
    }))
    .sort((a, b) => b.costMicroCny - a.costMicroCny || totalTokens(b.tokens) - totalTokens(a.tokens));

  const byTurn = [...turns.values()]
    .map((entry) => ({
      ...entry,
      costCny: entry.costMicroCny / 1e6,
      totalTokens: totalTokens(entry.tokens),
      cacheHit: billedInputTokens(entry.tokens) === 0 ? null : entry.tokens.cacheReadTokens / billedInputTokens(entry.tokens),
    }))
    .sort((a, b) => a.turn - b.turn);

  const unpricedModels = [...new Set(billed.filter((record) => !record.priced).map((record) => record.model).filter(Boolean))];

  return {
    records: billed,
    totals: {
      tokens: totalsBuckets,
      totalTokens: totalTokens(totalsBuckets),
      costMicroCny: totalMicro,
      costCny: totalMicro / 1e6,
      billedInputTokens: billedInputTokens(totalsBuckets),
      cacheHit: billedInputTokens(totalsBuckets) === 0 ? null : totalsBuckets.cacheReadTokens / billedInputTokens(totalsBuckets),
      samples: billed.length,
    },
    byModel,
    byTurn,
    unpricedModels,
    warnings: [...new Set(warnings)],
  };
}

