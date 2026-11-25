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
import {
  addBuckets,
  billedInputTokens,
  canonicalProvider,
  costMicroCny,
  costMicroUsd,
  isOfficialProvider,
  isUsdProvider,
  priceAt,
  priceTier,
  resolvePrice,
  resolveUsdPrice,
  zeroBuckets,
} from './pricing.mjs';
import { billableRates, priceProviderSample } from './provider-pricing.mjs';
import { sortCostMicro } from './money.mjs';

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
 * @param usdPricing - USD list prices for dollar-billed routes (codex).
 * @param providerPricing - provider-scoped card (AICodeMirror); only its own
 *   route is priced from it, so one provider's row never reprices another's.
 * @returns per-model, per-turn, and whole-session cost figures.
 */
export function analyzeEvents(events, pricing, usdPricing = null, providerPricing = null) {
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
        // opencode/opencode-go is billed by the OpenCode console: its cost only
        // exists as official USD rows, so the CNY table must stay out of it.
        const officialProvider = isOfficialProvider(active.provider);
        // A provider-scoped card outranks every shared table: the same model id
        // can be quoted differently by two routes, and only the route that
        // actually served the request may price it. Other providers keep the
        // exact tables they had before.
        const card = officialProvider
          ? null
          : priceProviderSample({ doc: providerPricing, provider: active.provider, model: active.model, buckets });
        const cardRates = card !== null && card.status === 'price' ? billableRates(card) : null;
        const lookup = officialProvider || card !== null ? null : resolvePrice(active.model, pricing);
        const resolved = lookup;
        // Dollar-billed routes (codex) are costed from the USD list price and
        // never from the CNY table, so the two currencies stay separate.
        const tierLookup = officialProvider ? resolvePrice(active.model, pricing) : lookup;
        const usdResolved =
          !officialProvider && card === null && isUsdProvider(active.provider, usdPricing)
            ? resolveUsdPrice(active.model, usdPricing)
            : null;
        const record = {
          seq: event.seq,
          time: event.time,
          turn,
          step,
          provider: active.provider,
          model: active.model,
          priceKey:
            officialProvider
              ? 'opencode-pending'
              : card !== null
                ? card.priceKey
                : usdResolved !== null
                  ? `usd-${usdResolved.key}`
                  : (resolved?.key ?? null),
          priced: cardRates !== null || resolved !== null || usdResolved !== null,
          // Peak/off split for two-tier models. Official rows have no CNY price,
          // so the lookup is only used to know whether the model is tiered; a
          // provider card splits by context tier instead.
          tier: priceTier(tierLookup?.price ?? null, event.time),
          // A provider card splits by context tier instead of by clock.
          contextTier: card !== null && card.tier !== null ? card.tier.id : null,
          contextTokens: card !== null ? card.contextTokens : null,
          cardGroup: card !== null ? card.groupId : null,
          estimated: card !== null && card.estimated === true,
          estimatedReason: card !== null ? card.estimatedReason : null,
          officialProvider,
          buckets,
          // `event.time` selects the tier: two-tier models (DeepSeek) bill
          // off-peak samples at the discounted rate of the sample's own clock.
          // A provider card bills every bucket at its own CNY rate (USD x the
          // group factor), so the sample contributes no USD at all.
          costMicroCny:
            cardRates !== null
              ? costMicroCny(buckets, cardRates)
              : resolved === null
                ? 0
                : costMicroCny(buckets, resolved.price, event.time),
          costMicroUsd: usdResolved === null ? 0 : costMicroUsd(buckets, usdResolved.price),
          cacheSavingMicroCny:
            cardRates !== null
              ? Math.round(buckets.cacheReadTokens * (cardRates.input - cardRates.cacheRead))
              : resolved === null
                ? 0
                : Math.round(buckets.cacheReadTokens * (priceAt(resolved.price, event.time).input - priceAt(resolved.price, event.time).cacheRead)),
          cacheSavingMicroUsd:
            usdResolved === null
              ? 0
              : Math.round(buckets.cacheReadTokens * (usdResolved.price.input - usdResolved.price.cacheRead)),
        };
        if (card !== null && card.status === 'ambiguous') {
          warnings.push(
            `ambiguous price for model "${active.model}" (provider ${active.provider}): tiers ${card.tiers.map((tier) => tier.id).join('/')} overlap at ${card.contextTokens} prompt tokens`,
          );
        }
        if (!officialProvider && !card && !resolved && !usdResolved && active.model) warnings.push(`no price for model "${active.model}" (provider ${active.provider ?? 'unknown'})`);
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
  let totalMicroUsd = 0;
  const models = new Map();
  const turns = new Map();
  for (const record of billed) {
    addBuckets(totalsBuckets, record.buckets);
    totalMicro += record.costMicroCny;
    totalMicroUsd += record.costMicroUsd ?? 0;
    const modelProvider = canonicalProvider(record.provider);
    // A provider card splits its rows by context tier (standard / long), the same
    // way DeepSeek splits by clock tier, so a blended rate never hides which
    // published tier was charged.
    const modelKey = `${modelProvider ?? '?'}\u0000${record.model ?? '?'}\u0000${record.tier ?? ''}\u0000${record.contextTier ?? ''}`;
    let modelEntry = models.get(modelKey);
    if (modelEntry === undefined) {
      modelEntry = {
        provider: modelProvider,
        model: record.model,
        tier: record.tier ?? null,
        contextTier: record.contextTier ?? null,
        cardGroup: record.cardGroup ?? null,
        priceKey: record.priceKey,
        priced: record.priced,
        estimated: false,
        estimatedReason: null,
        officialProvider: record.officialProvider === true,
        tokens: zeroBuckets(),
        costMicroCny: 0,
        costMicroUsd: 0,
        cacheSavingMicroCny: 0,
        cacheSavingMicroUsd: 0,
        samples: 0,
      };
      models.set(modelKey, modelEntry);
    }
    addBuckets(modelEntry.tokens, record.buckets);
    modelEntry.costMicroCny += record.costMicroCny;
    modelEntry.costMicroUsd += record.costMicroUsd ?? 0;
    modelEntry.cacheSavingMicroCny += record.cacheSavingMicroCny ?? 0;
    modelEntry.cacheSavingMicroUsd += record.cacheSavingMicroUsd ?? 0;
    if (record.estimated === true) {
      modelEntry.estimated = true;
      modelEntry.estimatedReason = modelEntry.estimatedReason ?? record.estimatedReason ?? 'estimate';
    }
    modelEntry.samples += 1;
    let turnEntry = turns.get(record.turn);
    if (turnEntry === undefined) {
      turnEntry = { turn: record.turn, tokens: zeroBuckets(), costMicroCny: 0, costMicroUsd: 0, steps: 0 };
      turns.set(record.turn, turnEntry);
    }
    addBuckets(turnEntry.tokens, record.buckets);
    turnEntry.costMicroCny += record.costMicroCny;
    turnEntry.costMicroUsd += record.costMicroUsd ?? 0;
    turnEntry.steps += 1;
  }

  const byModel = [...models.values()]
    .map((entry) => ({
      ...entry,
      costCny: entry.costMicroCny / 1e6,
      costUsd: entry.costMicroUsd / 1e6,
      share: totalMicro === 0 ? 0 : entry.costMicroCny / totalMicro,
    }))
    .sort((a, b) => sortCostMicro(b) - sortCostMicro(a) || totalTokens(b.tokens) - totalTokens(a.tokens));

  const byTurn = [...turns.values()]
    .map((entry) => ({
      ...entry,
      costCny: entry.costMicroCny / 1e6,
      costUsd: 0,
      totalTokens: totalTokens(entry.tokens),
      cacheHit: billedInputTokens(entry.tokens) === 0 ? null : entry.tokens.cacheReadTokens / billedInputTokens(entry.tokens),
    }))
    .sort((a, b) => a.turn - b.turn);

  const unpricedModels = [...new Set(billed.filter((record) => !record.priced && record.officialProvider !== true).map((record) => record.model).filter(Boolean))];
  // Official-provider usage with no archived console row yet: tokens are real,
  // the amount is "pending official bill" rather than a CNY estimate.
  const pendingModels = [...new Set(billed.filter((record) => record.officialProvider === true).map((record) => record.model).filter(Boolean))];

  return {
    records: billed,
    totals: {
      tokens: totalsBuckets,
      totalTokens: totalTokens(totalsBuckets),
      costMicroCny: totalMicro,
      costCny: totalMicro / 1e6,
      costMicroUsd: totalMicroUsd,
      costUsd: totalMicroUsd / 1e6,
      billedInputTokens: billedInputTokens(totalsBuckets),
      cacheHit: billedInputTokens(totalsBuckets) === 0 ? null : totalsBuckets.cacheReadTokens / billedInputTokens(totalsBuckets),
      samples: billed.length,
      // Samples whose money is an estimate (unpublished cache-write rate or a
      // request past the published context tier), so the report can say so.
      estimatedSamples: billed.filter((record) => record.estimated === true).length,
    },
    byModel,
    byTurn,
    unpricedModels,
    pendingModels,
    warnings: [...new Set(warnings)],
  };
}

