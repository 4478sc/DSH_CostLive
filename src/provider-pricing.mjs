/**
 * Provider-partitioned price cards.
 *
 * The legacy CNY table (config/pricing.json) is keyed by model id alone, so one
 * model id has exactly one price no matter which route served it. That is wrong
 * as soon as two providers publish the same model at different rates: the same
 * "claude-sonnet-5-5" can be an AICodeMirror CNY quote, an Anthropic USD list
 * price, or a console invoice. This module keeps a provider-scoped card next to
 * the legacy tables and never lets one provider's row price another provider's
 * request.
 *
 * A card is a list of groups (provider product lines). Each group carries one
 * fixed CNY/USD factor, so a bucket's CNY rate is exactly
 * `round(usdRate * factor, 6)`; billing then multiplies every bucket by that CNY
 * rate. Two currencies are never added into one column, and a provider priced
 * here contributes zero USD.
 *
 * Tiers are per-request: `standard` applies up to `upTo` prompt tokens, `long`
 * above `over`. The public AICodeMirror endpoint still prints `<=272K` and
 * `>100K` for claude-haiku-5-5, which overlap; the owner corrected that model to
 * a 100K split, so the shipped card carries no overlap while the generic guard
 * still reports any real overlap as ambiguous and leaves it unpriced.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeModelId } from './pricing.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Shipped AICodeMirror rate card. */
export const DEFAULT_PROVIDER_PRICING_PATH = join(HERE, '..', 'config', 'aicodemirror-pricing.json');

/** The single provider this card prices; every other route keeps its own table. */
export const AICODEMIRROR_PROVIDER = 'aicodemirror1';

const RATE_FIELDS = ['input', 'output', 'cacheWrite', 'cacheRead'];

/** Round a derived CNY rate to 6 decimals, the precision the card publishes. */
export function cnyFromUsd(usd, factor) {
  return Math.round(usd * factor * 1e6) / 1e6;
}

/** True when the route is the provider this card is scoped to. */
export function isAicodemirrorProvider(provider) {
  return typeof provider === 'string' && provider.trim().toLowerCase() === AICODEMIRROR_PROVIDER;
}

function requireString(where, value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('provider-pricing: ' + where + ' must be a non-empty string');
  return value.trim();
}

/** One tier: bounds plus the four USD rates (cacheWrite may be null = unpublished). */
function tierRecord(where, value, id) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('provider-pricing: ' + where + ' must be an object');
  }
  const upTo = value.upTo;
  const over = value.over;
  if (upTo !== undefined && (!Number.isInteger(upTo) || upTo <= 0)) throw new Error('provider-pricing: ' + where + '.upTo must be a positive integer');
  if (over !== undefined && (!Number.isInteger(over) || over < 0)) throw new Error('provider-pricing: ' + where + '.over must be a non-negative integer');
  const usd = {};
  for (const field of RATE_FIELDS) {
    const rate = value[field];
    if (rate === null && field === 'cacheWrite') {
      // Documented as "not published": billing falls back to the input rate and
      // flags the row, and the page prints a dash instead of a made-up number.
      usd.cacheWrite = null;
      continue;
    }
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
      throw new Error('provider-pricing: ' + where + '.' + field + ' must be a non-negative finite number');
    }
    usd[field] = rate;
  }
  return { id, upTo: upTo ?? null, over: over ?? null, usd };
}

/** Validate and normalize one card document. */
export function normalizeProviderPricing(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('provider-pricing: document must be an object');
  const provider = requireString('provider', raw.provider).toLowerCase();
  const unitTokens = raw.unitTokens ?? 1000000;
  if (!Number.isInteger(unitTokens) || unitTokens <= 0) throw new Error('provider-pricing: unitTokens must be a positive integer');
  const quoteCurrency = raw.quoteCurrency === undefined ? 'USD' : requireString('quoteCurrency', raw.quoteCurrency).toUpperCase();
  const billingCurrency = raw.billingCurrency === undefined ? 'CNY' : requireString('billingCurrency', raw.billingCurrency).toUpperCase();
  if (quoteCurrency !== 'USD') throw new Error('provider-pricing: quoteCurrency must be USD');
  if (billingCurrency !== 'CNY') throw new Error('provider-pricing: billingCurrency must be CNY');
  if (!Array.isArray(raw.groups) || raw.groups.length === 0) throw new Error('provider-pricing: groups must be a non-empty array');

  const groups = [];
  const index = new Map();
  const seenGroups = new Set();
  for (const [groupIndex, groupRaw] of raw.groups.entries()) {
    const where = 'groups[' + groupIndex + ']';
    if (groupRaw === null || typeof groupRaw !== 'object' || Array.isArray(groupRaw)) throw new Error('provider-pricing: ' + where + ' must be an object');
    const id = requireString(where + '.id', groupRaw.id).toLowerCase();
    if (seenGroups.has(id)) throw new Error('provider-pricing: duplicate group id "' + id + '"');
    seenGroups.add(id);
    const label = requireString(where + '.label', groupRaw.label);
    const factor = groupRaw.factor;
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0) throw new Error('provider-pricing: ' + where + '.factor must be a positive number');
    if (!Array.isArray(groupRaw.models) || groupRaw.models.length === 0) throw new Error('provider-pricing: ' + where + '.models must be a non-empty array');
    const models = [];
    for (const [modelIndex, modelRaw] of groupRaw.models.entries()) {
      const modelWhere = where + '.models[' + modelIndex + ']';
      const modelId = requireString(modelWhere + '.id', modelRaw?.id);
      const key = modelId.toLowerCase();
      if (index.has(key)) throw new Error('provider-pricing: duplicate model id "' + modelId + '"');
      const tiers = [];
      for (const tierId of ['standard', 'long']) {
        const tierRaw = modelRaw[tierId];
        if (tierRaw === undefined) continue;
        const tier = tierRecord(modelWhere + '.' + tierId, tierRaw, tierId);
        tier.cny = {};
        for (const field of RATE_FIELDS) {
          tier.cny[field] = tier.usd[field] === null ? null : cnyFromUsd(tier.usd[field], factor);
        }
        tiers.push(tier);
      }
      if (tiers.length === 0) throw new Error('provider-pricing: ' + modelWhere + ' needs a standard or long tier');
      for (const tier of tiers) {
        if (tier.id === 'long' && tier.over === null) throw new Error('provider-pricing: ' + modelWhere + '.long.over is required');
        if (tier.id === 'standard' && tiers.length > 1 && tier.upTo === null) throw new Error('provider-pricing: ' + modelWhere + '.standard.upTo is required when a long tier exists');
      }
      const model = { id: modelId, groupId: id, tiers };
      models.push(model);
      index.set(key, model);
    }
    groups.push({ id, label, factor, models });
  }

  return {
    provider,
    quoteCurrency,
    billingCurrency,
    unitTokens,
    groups,
    index,
    // Provenance travels with the card so the price page can name its source
    // instead of presenting an anonymous number.
    source: typeof raw._source === 'string' && raw._source.trim() !== '' ? raw._source.trim() : null,
    policy: typeof raw._policy === 'string' && raw._policy.trim() !== '' ? raw._policy.trim() : null,
  };
}

/** Load the shipped card; a missing file means "no provider card", not an error. */
export function loadProviderPricing(path = DEFAULT_PROVIDER_PRICING_PATH) {
  try {
    return normalizeProviderPricing(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error('provider-pricing: ' + path + ' is not valid JSON: ' + error.message);
    throw error;
  }
}

/** Candidate ids for one request model: exact, then without a date/preview suffix. */
export function modelCandidates(model) {
  const base = normalizeModelId(model);
  if (base === '') return [];
  const out = [base];
  const trimmed = base
    .replace(/-\d{4}-\d{2}-\d{2}$/u, '')
    .replace(/-\d{8}$/u, '')
    .replace(/-(latest|stable|preview)$/u, '');
  if (trimmed !== '' && trimmed !== base) out.push(trimmed);
  return out;
}

/** One model entry from the card, or null when the provider does not publish it. */
export function findProviderModel(doc, model) {
  if (doc === null || doc === undefined) return null;
  for (const id of modelCandidates(model)) {
    const entry = doc.index.get(id);
    if (entry !== undefined) return entry;
  }
  return null;
}

/**
 * Which tier covers one request, given the request's prompt-side token total.
 * Prompt tokens include the cache buckets: a 200K prompt with 150K cached is
 * still a 200K request, and the published thresholds are context windows.
 */
export function selectTier(model, contextTokens) {
  const ctx = Number.isFinite(contextTokens) && contextTokens > 0 ? Math.floor(contextTokens) : 0;
  const covering = model.tiers.filter(
    (tier) => (tier.upTo === null || ctx <= tier.upTo) && (tier.over === null || ctx > tier.over),
  );
  if (covering.length === 1) return { status: 'price', tier: covering[0], tiers: covering };
  if (covering.length > 1) return { status: 'ambiguous', tier: null, tiers: covering };
  // Only reachable when a single published tier carries an upper bound that the
  // request exceeds: bill at that rate but mark the row as an estimate rather
  // than pretending the request was inside the published range (or, worse,
  // pricing it as free).
  const bounded = model.tiers.filter((tier) => tier.upTo !== null && ctx > tier.upTo);
  if (bounded.length === 1) return { status: 'over', tier: bounded[0], tiers: bounded };
  return { status: 'none', tier: null, tiers: [] };
}

/** Human bound of one tier, e.g. "<=272K" or ">100K". */
export function describeTier(tier, formatK) {
  const fmt = typeof formatK === 'function' ? formatK : (value) => String(value);
  if (tier.upTo !== null && tier.over !== null) return fmt(tier.over) + '< x <=' + fmt(tier.upTo);
  if (tier.upTo !== null) return '<=' + fmt(tier.upTo);
  if (tier.over !== null) return '>' + fmt(tier.over);
  return 'any';
}

/**
 * Price one request sample against a provider card.
 */
export function priceProviderSample({ doc, provider, model, buckets }) {
  if (doc === null || doc === undefined) return null;
  if (!isAicodemirrorProvider(provider)) return null;
  const entry = findProviderModel(doc, model);
  if (entry === null) return null;
  const group = doc.groups.find((item) => item.id === entry.groupId);
  const contextTokens =
    (buckets?.uncachedInputTokens ?? 0) + (buckets?.cacheWriteTokens ?? 0) + (buckets?.cacheReadTokens ?? 0);
  const selection = selectTier(entry, contextTokens);
  const base = {
    provider: doc.provider,
    groupId: group.id,
    groupLabel: group.label,
    factor: group.factor,
    contextTokens,
  };
  if (selection.status === 'ambiguous') {
    return { ...base, status: 'ambiguous', tier: null, tiers: selection.tiers, usd: null, cny: null, priceKey: 'acm-ambiguous', estimated: false, estimatedReason: null };
  }
  if (selection.status === 'none') return null;
  const tier = selection.tier;
  const missingCacheWrite = tier.usd.cacheWrite === null;
  const usedCacheWrite = (buckets?.cacheWriteTokens ?? 0) > 0;
  const estimatedReason =
    selection.status === 'over'
      ? missingCacheWrite && usedCacheWrite
        ? 'context-over+cache-write-missing'
        : 'context-over'
      : missingCacheWrite && usedCacheWrite
        ? 'cache-write-missing'
        : null;
  return {
    ...base,
    status: 'price',
    tier,
    tiers: [tier],
    usd: tier.usd,
    cny: tier.cny,
    priceKey: 'acm-' + group.id + '-' + tier.id,
    // A request past a lone published tier is still billed at that rate, but as
    // an explicit estimate: pricing it as free would be worse than flagging it.
    contextOver: selection.status === 'over',
    estimated: estimatedReason !== null,
    estimatedReason,
  };
}

/** Four CNY rates usable by costMicroCny(); a missing cache write falls back to input. */
export function billableRates(price) {
  if (price === null || price === undefined || price.cny === null) return null;
  const cny = price.cny;
  return {
    input: cny.input,
    output: cny.output,
    cacheWrite: cny.cacheWrite === null ? cny.input : cny.cacheWrite,
    cacheRead: cny.cacheRead,
  };
}

/** Counts the card publishes, used by the page header, docs and tests. */
export function summarizeProviderPricing(doc) {
  if (doc === null || doc === undefined) return { provider: null, groups: 0, models: 0, tiers: 0, longTiers: 0, groupsById: {} };
  const groups = doc.groups.length;
  const models = doc.groups.reduce((sum, group) => sum + group.models.length, 0);
  const tiers = doc.groups.reduce((sum, group) => sum + group.models.reduce((inner, model) => inner + model.tiers.length, 0), 0);
  const longTiers = doc.groups.reduce(
    (sum, group) => sum + group.models.reduce((inner, model) => inner + (model.tiers.some((tier) => tier.id === 'long') ? 1 : 0), 0),
    0,
  );
  return { provider: doc.provider, groups, models, tiers, longTiers, groupsById: Object.fromEntries(doc.groups.map((group) => [group.id, group.models.length])) };
}
