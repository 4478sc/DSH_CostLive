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

/** "￥12.3456", "$0.7891", or "￥12.3456+$0.7891" when both are non-zero. */
export function formatMoney(microCny = 0, microUsd = 0) {
  const parts = [];
  if (microCny > 0) parts.push(formatCny(microCny / 1e6));
  if (microUsd > 0) parts.push(formatUsd(microUsd / 1e6));
  if (parts.length === 0) return formatCny(0);
  return parts.join('+');
}
