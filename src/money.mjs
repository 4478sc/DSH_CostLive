/**
 * Two currencies, never mixed.
 *
 * Local DSH sessions are priced in CNY by `config/pricing.json`; official
 * OpenCode rows are billed in USD by the console. Converting one into the other
 * would hide which number is authoritative, so every total keeps both columns:
 * `costMicroCny` (local table) and `costMicroUsd` (official console).
 *
 * `SORT_USD_TO_CNY` is a fixed ordering constant only: it lets a $5 session sit
 * next to a ¥35 one in a cost-sorted list. It never enters a sum.
 */
import { formatCny } from './pricing.mjs';

export const SORT_USD_TO_CNY = 7.1;

/** Ordering key for mixed-currency rows. */
export function sortCostMicro(entry) {
  return (entry?.costMicroCny ?? 0) + (entry?.costMicroUsd ?? 0) * SORT_USD_TO_CNY;
}

/** True when either currency has a non-zero amount. */
export function hasCost(entry) {
  return (entry?.costMicroCny ?? 0) > 0 || (entry?.costMicroUsd ?? 0) > 0;
}

/** USD text with the same adaptive precision as formatCny(). */
export function formatUsd(value) {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 4 : 6;
  return '$' + value.toFixed(digits);
}

/**
 * Average price of one million tokens, split by currency.
 *
 * Only tokens that actually carry a price are counted: locally priced models
 * contribute to the CNY average, official OpenCode rows to the USD one.
 * Unpriced models (any id absent from the active price table) and official
 * usage still waiting for a console row (`opencode-pending`) are excluded
 * from both the cost and the token count, so they cannot drag the average down.
 *
 * @returns {{cnyTokens:number, usdTokens:number, cnyMicroPerM:number, usdMicroPerM:number}}
 */
export function averageTokenPrice(models) {
  let cnyTokens = 0;
  let cnyMicro = 0;
  let usdTokens = 0;
  let usdMicro = 0;
  for (const model of Array.isArray(models) ? models : []) {
    if (model === null || model === undefined) continue;
    const tokens = model.tokens ?? {};
    const total =
      (tokens.uncachedInputTokens || 0) +
      (tokens.outputTokens || 0) +
      (tokens.cacheWriteTokens || 0) +
      (tokens.cacheReadTokens || 0);
    if (total <= 0) continue;
    const usdPriced =
      model.priceKey === 'opencode-official' ||
      (typeof model.priceKey === 'string' && model.priceKey.startsWith('usd-'));
    if (usdPriced) {
      usdTokens += total;
      usdMicro += model.costMicroUsd || 0;
    } else if (model.priced === true) {
      cnyTokens += total;
      cnyMicro += model.costMicroCny || 0;
    }
  }
  return {
    cnyTokens,
    usdTokens,
    cnyMicroPerM: cnyTokens === 0 ? 0 : Math.round((cnyMicro * 1e6) / cnyTokens),
    usdMicroPerM: usdTokens === 0 ? 0 : Math.round((usdMicro * 1e6) / usdTokens),
  };
}

/** "￥12.3456", "$0.7891", or "￥12.3456+$0.7891" when both are non-zero. */
export function formatMoney(microCny = 0, microUsd = 0) {
  const parts = [];
  if (microCny > 0) parts.push(formatCny(microCny / 1e6));
  if (microUsd > 0) parts.push(formatUsd(microUsd / 1e6));
  if (parts.length === 0) return formatCny(0);
  return parts.join('+');
}
